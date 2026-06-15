#!/usr/bin/env python3
"""Post-submission outcome scanner for the auto-apply pipeline (stdlib only — no new deps).

Polls the job-applications inbox (config/email-imap.json — the SAME inbox the forms submit to
and check-email-code.mjs polls) for EMPLOYER RESPONSE emails, classifies each into an outcome,
matches it back to a SUBMITTED row in tracker.csv by company name, and records the result in the
trailing `followup_status` column. IMAP runs on Python's stdlib imaplib + ssl, so there are no
new dependencies. There is NO Telegram/notifier coupling: the default output is a print-only
digest to stdout.

Outcome vocabulary (followup_status):  interview | oa | offer | rejection | ghosted | '' (pending)
  - interview / oa / offer .... POSITIVE — surfaced prominently in the digest
  - rejection ................. recorded and reported (so closures are visible too)
  - ghosted ................... inferred by age (submitted > --ghost-days ago, still no response)
  - '' (empty) ................ pending / no signal yet

Idempotent: it recomputes followup_status from the inbox every run and only reports a row when its
status CHANGES, so re-running the same day is a no-op (no duplicate output).

Usage:
  python3 src/scan-followups.py                 # scan, update tracker.csv, print digest to stdout
  python3 src/scan-followups.py --dry-run       # classify + match + report, write nothing
  python3 src/scan-followups.py --lookback-days 60 --ghost-days 21 --verbose

Tuning: the keyword lists (ACK_SUBJECT / REJECTION_DECISIVE / *_PHRASES / HEDGE) and the legal-suffix
guard (LEGAL) below are what to edit when a real email is mis-read. Exits 0 even on a fatal error
(it prints one diagnostic line so a scheduled run is never silently empty).
"""
import argparse
import csv
import datetime as dt
import email
import email.utils
import html
import imaplib
import json
import os
import re
import shutil
import sys
from email.header import decode_header, make_header

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRACKER = os.path.join(ROOT, "tracker.csv")
CREDS = os.path.join(ROOT, "config", "email-imap.json")
TRACKER_LOCK = "/tmp/auto-apply-tracker.lock"     # same lock the apply workers use (best-effort)

# tracker.csv schema. followup_status is the trailing column so every existing whole-line regex
# reader (next-jobs.mjs / discover.mjs / build-queue.py — they find url/status BEFORE notes) keeps
# working untouched.
BASE_COLS = ["date", "company", "role", "url", "ats", "resume_file", "status", "screenshot", "notes"]
FOLLOWUP_COL = "followup_status"
HEADER = BASE_COLS + [FOLLOWUP_COL]

POSITIVE = ("offer", "interview", "oa")           # surfaced prominently in the digest
VALID_FOLLOWUP = {"", "interview", "oa", "offer", "rejection", "ghosted"}
# funnel rank so positives only ever ratchet UP (an interview is never silently downgraded to oa)
RANK = {"": 0, "ghosted": 0, "rejection": 0, "oa": 1, "interview": 2, "offer": 3}

LABEL = {
    "offer": "OFFER",
    "interview": "INTERVIEW",
    "oa": "ASSESSMENT",
    "rejection": "rejection",
    "ghosted": "ghosted",
}

# ---------------------------------------------------------------------------
# Outcome classification.
#
# The hard lesson from a real apply inbox: it is ~all auto-acknowledgements, and their bodies
# DESCRIBE the future process in conditional terms — "we'll reach out to schedule a call IF...",
# "the next step MAY include a video interview", "IF you are not selected...". Naive keyword
# matching reads those as interviews/rejections. So classification is deliberately conservative —
# a false "INTERVIEW!" reading erodes trust far faster than a missed one (you can always read the
# mail):
#
#   1. ACK GATE first. If the SUBJECT is a confirmation ("thank you for applying", "nice to meet
#      you & next steps", "application received", a security code) the email is an auto-ack and
#      yields NO outcome — regardless of process boilerplate in the body. A real recruiter
#      response does not carry a "thank you for applying" subject.
#   2. A DECISIVE, NON-CONDITIONAL rejection phrase overrides the ack gate (auto-reject emails do
#      reuse a "thank you" subject). The list excludes the ack-boilerplate "not selected for" /
#      "wish you the best" so confirmations don't read as rejections.
#   3. Positive outcomes (offer/oa/interview) require committed language AND survive a HEDGE veto:
#      a conditional word ("if", "may", "reach out", "in touch") just before the phrase => not yet.
# ---------------------------------------------------------------------------

# 1) Confirmation/system SUBJECTS -> auto-ack -> no outcome.
ACK_SUBJECT = [
    "thank you for apply", "thanks for apply", "thank you for your application",
    "thank you for submitting", "thank you for your interest", "thanks for your application",
    "thanks for your interest", "thank you for your submission", "application received",
    "received your application", "application has been received", "we received your",
    "application confirmation", "nice to meet you", "confirm your", "security code",
    "verification code", "verify your email", "your application was received",
]

# 2) DECISIVE rejection phrases (non-conditional). These may override the ack gate.
REJECTION_DECISIVE = [
    "we regret to inform", "regret to inform you", "not be moving forward with your",
    "will not be moving forward", "won't be moving forward", "not moving forward with your",
    "decided not to move forward", "decided to move forward with other",
    "move forward with other candidates", "decided to pursue other", "pursue other candidates",
    "will not be progressing", "not be progressing your", "not to proceed with your application",
    "decided not to proceed with your", "position has been filled", "role has been filled",
    "no longer being considered", "not be advancing your", "have selected other candidates",
    "moving forward with other applicants", "decided not to advance",
]

# 3) Positive phrases (subject to the hedge veto).
OFFER_PHRASES = [
    "pleased to offer", "excited to offer you", "happy to offer you", "offer of employment",
    "offer letter", "extend an offer", "extend you an offer", "would like to offer you the",
    "we are offering you", "formal offer", "verbal offer",
]
OA_PHRASES = [
    "online assessment", "coding challenge", "coding assessment", "skills assessment",
    "take-home", "take home assignment", "hackerrank", "codility", "codesignal", "coderpad",
    "complete the assessment", "complete this assessment", "complete a short assessment",
    "assessment link", "please complete the following", "case study exercise",
]
INTERVIEW_PHRASES = [
    "schedule a call", "schedule a time", "schedule some time", "schedule an interview",
    "schedule your interview", "set up a call", "set up some time", "set up a time",
    "find a time", "book a time", "pick a time", "select a time", "self-schedule",
    "your availability", "share your availability", "what is your availability",
    "phone screen", "phone interview", "video interview", "initial interview",
    "invite you to interview", "like to interview you", "move forward with an interview",
    "speak with you", "meet with the team", "introductory call", "recruiter screen",
    "calendly.com", "savvycal.com", "use the link below to schedule", "are you available",
]

# Conditional / future hedges. If one appears within HEDGE_WINDOW chars before a positive phrase,
# the email is describing the process, not inviting -> veto the positive.
HEDGE = [
    "if ", "should ", "may ", "might ", "in the event", "reach out", "be in touch", "in touch",
    "once we", "after we", "after reviewing", "we'll be", "we will be", "if we", "if your",
    "if you", "select few", "moving to a", "typically", "the process", "our process",
    "next step may", "next steps may", "would like to schedule an interview. candidate",
]
HEDGE_WINDOW = 60

# Legal-suffix noise dropped from company names before matching.
LEGAL = {
    "inc", "llc", "corp", "co", "ltd", "plc", "gmbh", "sa", "ag", "nv", "group", "holdings",
    "holding", "technologies", "technology", "labs", "lab", "company", "the", "and",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def log(*a):
    print(*a, file=sys.stderr, flush=True)


def split_camel(s):
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s)


def norm_name(s):
    """Lowercase, de-camelCase, strip punctuation + legal suffixes -> 'jane street'."""
    s = split_camel(s)
    s = re.sub(r"[^A-Za-z0-9]+", " ", s).lower().strip()
    toks = [t for t in s.split() if t and t not in LEGAL]
    return " ".join(toks)


def company_aliases(company):
    """A set of normalized alias phrases for a company, including parenthetical / segment aliases.
    'Truebill (Rocket Money)' -> {'truebill', 'rocket money'}; 'ecoATM | Gazelle' -> {'ecoatm','gazelle'}."""
    aliases = set()
    segments = [company] + re.split(r"[()|]|\s-\s", company)
    for seg in segments:
        n = norm_name(seg)
        if n:
            aliases.add(n)
    aliases = {a for a in aliases if a}
    compact = {a.replace(" ", "") for a in aliases if len(a.replace(" ", "")) >= 5}
    return aliases, compact


def compile_company(company):
    """Compile per-alias matchers.

    Identity is matched in the STRONG field (From + Subject) only, EXCEPT multiword aliases and
    long brand strings, which may also match in the body. This is the shared-inbox guard: a real
    outcome email names the company in its From-domain or Subject; a single generic token like
    'unity' or 'persona' in a noisy body footer is NOT identity and must not cross-match.
    """
    aliases, compact = company_aliases(company)
    compiled = []
    for a in aliases:
        multiword = " " in a
        compiled.append((re.compile(r"(?<![a-z0-9])" + re.escape(a) + r"(?![a-z0-9])"), multiword))
    return {"aliases": compiled, "compact": compact}


def match_score(comp, strong, body, strong_alnum, body_alnum):
    """1 if the company is identified in this email, else 0.

    strong = From + Subject (lowercased). Single-token aliases match strong only; multiword
    aliases also match the body; compact (de-spaced) aliases match the From/Subject domain, and
    long ones (>=9 chars, e.g. 'digitalocean') may also match the body."""
    for rx, multiword in comp["aliases"]:
        if rx.search(strong):
            return 1
        if multiword and rx.search(body):
            return 1
    for c in comp["compact"]:
        if c in strong_alnum:
            return 1
        if len(c) >= 9 and c in body_alnum:
            return 1
    return 0


def decode_str(raw):
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(raw)))
    except Exception:
        return raw


def get_body_text(msg):
    """Best-effort plain-text body: prefer text/plain parts, fall back to stripped HTML."""
    plains, htmls = [], []
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            if part.get_content_disposition() == "attachment":
                continue
            if ctype == "text/plain":
                plains.append(_decode_part(part))
            elif ctype == "text/html":
                htmls.append(_decode_part(part))
    else:
        if msg.get_content_type() == "text/html":
            htmls.append(_decode_part(msg))
        else:
            plains.append(_decode_part(msg))
    text = "\n".join(p for p in plains if p).strip()
    if not text:
        raw_html = "\n".join(h for h in htmls if h)
        text = strip_html(raw_html)
    return text


def _decode_part(part):
    try:
        payload = part.get_payload(decode=True)
        if payload is None:
            return ""
        charset = part.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="replace")
    except Exception:
        try:
            return part.get_payload()
        except Exception:
            return ""


def strip_html(s):
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"[ \t\r\f\v]+", " ", s).strip()


def _hedged(text, phrase):
    """True only if EVERY occurrence of `phrase` is preceded (within HEDGE_WINDOW) by a hedge.
    One un-hedged occurrence => a real signal => return False."""
    start = 0
    found = False
    while True:
        i = text.find(phrase, start)
        if i < 0:
            break
        found = True
        window = text[max(0, i - HEDGE_WINDOW):i]
        if not any(h in window for h in HEDGE):
            return False  # this occurrence is un-hedged -> real signal
        start = i + len(phrase)
    return found  # found >=1 occurrence and all were hedged


def _first_unhedged(text, phrases):
    return any(p in text and not _hedged(text, p) for p in phrases)


def is_ack_subject(subject):
    s = subject.lower()
    return any(p in s for p in ACK_SUBJECT)


def classify(subject, body):
    """Return an outcome label or None. None = not a real response (ack / code / process boilerplate).

    Order: decisive rejection (can override an ack subject) -> ack gate -> offer -> oa -> interview.
    """
    text = (subject + "\n" + body).lower()

    # decisive rejections win even under a "thank you for applying" subject
    if any(p in text for p in REJECTION_DECISIVE):
        return "rejection"

    # auto-acknowledgement: confirmation subject => no outcome (suppress process boilerplate)
    if is_ack_subject(subject):
        return None

    if _first_unhedged(text, OFFER_PHRASES):
        return "offer"
    if _first_unhedged(text, OA_PHRASES):
        return "oa"
    if _first_unhedged(text, INTERVIEW_PHRASES):
        return "interview"
    return None


# ---------------------------------------------------------------------------
# CSV read / write — robust to the hand-appended 9-col rows the apply agent writes (no followup
# token), one-off ragged rows (unquoted comma in notes), and our own clean 10-col rows. We ALWAYS
# csv.writer-quote on output, so our rows never go ragged; the only messy rows are external 9-col
# appends, which never carry a followup-vocabulary token at the end — that's how we disambiguate
# the trailing column.
# ---------------------------------------------------------------------------
def parse_row(fields):
    """-> (base9_list, followup_str). Recovers notes that got split by an unquoted comma."""
    if len(fields) >= 10 and fields[-1].strip().lower() in (VALID_FOLLOWUP - {""}):
        followup = fields[-1].strip().lower()
        notes = ",".join(fields[8:-1])
        base = fields[:8] + [notes]
    elif len(fields) == 10 and fields[-1] == "":
        # our own migrated-but-untouched row: [...8..., notes, '']
        followup = ""
        base = fields[:9]
    elif len(fields) >= 9:
        # external hand-written row, no followup column; fold any comma-split overflow into notes
        followup = ""
        notes = ",".join(fields[8:])
        base = fields[:8] + [notes]
    else:
        followup = ""
        base = (list(fields) + [""] * 9)[:9]
    return base, followup


def read_tracker():
    with open(TRACKER, newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    if not rows:
        return [], []
    data = []
    for r in rows[1:]:
        if not r or not any(c.strip() for c in r):
            continue
        base, followup = parse_row(r)
        data.append(base + [followup])
    return rows[0], data


def write_tracker(data):
    """Atomic write of header + 10-col rows, with a single rolling backup."""
    backup = TRACKER + ".bak-followups"
    try:
        shutil.copy2(TRACKER, backup)
    except Exception as e:
        log(f"[scan-followups] WARN: could not back up tracker: {e}")
    tmp = TRACKER + ".tmp-followups"
    with open(tmp, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(HEADER)
        for row in data:
            w.writerow(row[:10] if len(row) >= 10 else row + [""] * (10 - len(row)))
    os.replace(tmp, TRACKER)


# ---------------------------------------------------------------------------
# IMAP scan (stdlib imaplib + ssl)
# ---------------------------------------------------------------------------
def scan_inbox(lookback_days):
    """-> list of {date(aware UTC), outcome, strong, body, strong_alnum, body_alnum, subject, frm}."""
    creds = json.load(open(CREDS, encoding="utf-8"))
    host = creds.get("host", "imap.gmail.com")
    port = int(creds.get("port", 993))
    user = creds.get("user") or creds.get("email")
    password = creds.get("password") or creds.get("pass")
    M = imaplib.IMAP4_SSL(host, port)
    M.login(user, password)
    try:
        M.select("INBOX", readonly=True)
        since = (dt.date.today() - dt.timedelta(days=lookback_days)).strftime("%d-%b-%Y")
        typ, data = M.search(None, f"(SINCE {since})")
        ids = data[0].split()
        emails = []
        # fetch in chunks to keep the command line + memory sane
        for i in range(0, len(ids), 50):
            chunk = b",".join(ids[i:i + 50])
            typ, fetched = M.fetch(chunk, "(RFC822)")
            for part in fetched:
                if not isinstance(part, tuple):
                    continue
                try:
                    msg = email.message_from_bytes(part[1])
                except Exception:
                    continue
                subject = decode_str(msg.get("Subject", ""))
                frm = decode_str(msg.get("From", ""))
                try:
                    when = email.utils.parsedate_to_datetime(msg.get("Date"))
                    if when is not None and when.tzinfo is None:
                        when = when.replace(tzinfo=dt.timezone.utc)
                except Exception:
                    when = None
                if when is None:
                    when = dt.datetime.now(dt.timezone.utc)
                body = get_body_text(msg)
                outcome = classify(subject, body)
                strong = (frm + " \n " + subject).lower()
                bl = body.lower()
                emails.append({
                    "date": when.astimezone(dt.timezone.utc),
                    "outcome": outcome,
                    "subject": subject,
                    "frm": frm,
                    "strong": strong,
                    "body": bl,
                    "strong_alnum": re.sub(r"[^a-z0-9]", "", strong),
                    "body_alnum": re.sub(r"[^a-z0-9]", "", bl),
                })
        return emails
    finally:
        try:
            M.logout()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Core: match emails -> submitted rows, apply transitions
# ---------------------------------------------------------------------------
def transition(cur, det, age_days, ghost_days):
    """Return the new followup_status given current value + detected outcome (or None).

    Matches are already identity-confident (see match_score), so the only special-casing is:
    positives ratchet UP (never silently downgrade interview->oa) but a terminal negative can be
    re-engaged; a rejection records over anything EXCEPT a real offer."""
    if det is None:
        if cur == "" and age_days is not None and age_days > ghost_days:
            return "ghosted"
        return cur
    if det in POSITIVE:
        if RANK[det] > RANK.get(cur, 0) or cur in ("rejection", "ghosted"):
            return det
        return cur
    if det == "rejection":
        return cur if cur == "offer" else "rejection"  # never let a match nuke a real offer
    return cur


def run(args):
    header, data = read_tracker()
    fu_idx = 9  # followup_status is always the 10th column in our in-memory rows

    # index submitted rows
    submitted = [i for i, r in enumerate(data) if len(r) > 6 and r[6].strip() == "SUBMITTED"]
    # group by normalized company key, precompile aliases once per company
    comp_cache = {}
    groups = {}
    for i in submitted:
        company = data[i][1]
        key = norm_name(company) or company.lower()
        groups.setdefault(key, {"company": company, "rows": []})["rows"].append(i)
        if key not in comp_cache:
            comp_cache[key] = compile_company(company)

    log(f"[scan-followups] scanning inbox (lookback {args.lookback_days}d) ...")
    emails = scan_inbox(args.lookback_days)
    outcome_emails = [e for e in emails if e["outcome"] is not None]
    log(f"[scan-followups] {len(emails)} emails in window, "
        f"{len(outcome_emails)} carry an outcome keyword, "
        f"{len(submitted)} SUBMITTED rows across {len(groups)} companies.")

    today = dt.date.today()
    changes = []          # (row_idx, company, role, url, old, new, email_subject, email_date)
    matched_keys = set()

    # For each company, find its best (latest) outcome email and route it to one row.
    for key, g in groups.items():
        comp = comp_cache[key]
        hits = []
        for e in outcome_emails:
            if match_score(comp, e["strong"], e["body"], e["strong_alnum"], e["body_alnum"]):
                hits.append(e)
        if not hits:
            continue
        matched_keys.add(key)
        # latest email wins (reflects current funnel state)
        hits.sort(key=lambda e: e["date"], reverse=True)
        top_email = hits[0]
        det = top_email["outcome"]

        # route to one row: best role-title overlap with the email, else most-recently submitted
        target = pick_target_row(g["rows"], data, top_email)
        cur = (data[target][fu_idx] or "").strip().lower()
        age = row_age_days(data[target], today)
        new = transition(cur, det, age, args.ghost_days)
        if new != cur:
            data[target][fu_idx] = new
            changes.append((target, data[target][1], data[target][2], data[target][3],
                            cur, new, top_email["subject"], top_email["date"].date().isoformat()))

    # Ghost pass: submitted rows whose company had no matching outcome email and that have aged out
    for key, g in groups.items():
        if key in matched_keys:
            continue
        for i in g["rows"]:
            cur = (data[i][fu_idx] or "").strip().lower()
            if cur != "":
                continue
            age = row_age_days(data[i], today)
            if age is not None and age > args.ghost_days:
                data[i][fu_idx] = "ghosted"
                changes.append((i, data[i][1], data[i][2], data[i][3], cur, "ghosted", "", ""))

    return header, data, changes


def pick_target_row(row_idxs, data, e):
    if len(row_idxs) == 1:
        return row_idxs[0]
    hay = e["strong"] + " " + e["body"]
    best, best_score = row_idxs[0], (-1, "")
    for i in row_idxs:
        role = data[i][2].lower()
        toks = [t for t in re.findall(r"[a-z0-9]+", role) if len(t) >= 4]
        overlap = sum(1 for t in toks if t in hay)
        date = data[i][0]
        score = (overlap, date)  # role overlap, then most recent submit date (ISO sorts fine)
        if score > best_score:
            best, best_score = i, score
    return best


def row_age_days(row, today):
    try:
        d = dt.date.fromisoformat(row[0].strip()[:10])
        return (today - d).days
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
def build_digest(changes):
    """The stdout digest. Includes POSITIVE outcomes (interview/oa/offer) prominently AND
    rejections (so closures are visible too). Each change is reported once — the scan only emits a
    row when its followup_status actually changes, so no daily repeats. Ghosted is recorded but
    intentionally NOT reported (it's age-inferred, not an employer action, and would be a noisy
    bulk dump)."""
    pos = [c for c in changes if c[5] in POSITIVE]
    rej = [c for c in changes if c[5] == "rejection"]
    if not pos and not rej:
        return ""
    lines = []
    if pos:
        order = {"offer": 0, "interview": 1, "oa": 2}
        pos.sort(key=lambda c: order.get(c[5], 9))
        lines.append(f"Good news - {len(pos)} application update{'s' if len(pos) != 1 else ''}:")
        lines.append("")
        for _, company, role, url, old, new, subj, edate in pos:
            lines.append(f"{LABEL[new]} - {company}")
            if role:
                lines.append(f"  {role}")
            if subj:
                lines.append(f'  "{subj}" ({edate})')
            if url:
                lines.append(f"  {url}")
            lines.append("")
    if rej:
        lines.append(f"{len(rej)} rejection{'s' if len(rej) != 1 else ''}:")
        for _, company, role, url, old, new, subj, edate in rej:
            tail = f" - {role}" if role else ""
            tail += f" ({edate})" if edate else ""
            lines.append(f"  - {company}{tail}")
        lines.append("")
    return "\n".join(lines).strip()


# ---------------------------------------------------------------------------
# Best-effort tracker lock (stdlib fcntl on Unix; a no-op everywhere else)
# ---------------------------------------------------------------------------
def _acquire_lock():
    """Return an opaque handle to release later, or None if locking is unavailable. The IMAP scan
    is read-only and slow, so we only need the lock for the brief read-modify-write of tracker.csv,
    to avoid clobbering an in-flight apply-agent append."""
    try:
        import fcntl
        fh = open(TRACKER_LOCK, "w")
        fcntl.flock(fh, fcntl.LOCK_EX)
        return ("fcntl", fh)
    except Exception:
        return None


def _release_lock(handle):
    if not handle:
        return
    try:
        import fcntl
        _, fh = handle
        fcntl.flock(fh, fcntl.LOCK_UN)
        fh.close()
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser(description="Scan the apply inbox for job-application outcomes.")
    ap.add_argument("--lookback-days", type=int, default=45)
    ap.add_argument("--ghost-days", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true", help="classify + match, write nothing")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    lock = _acquire_lock()
    try:
        header, data, changes = run(args)
    except Exception as e:
        # fatal: surface ONE line on stdout so a scheduled run's output isn't silently empty
        print(f"followup scan failed: {e}")
        log(f"[scan-followups] FATAL: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return 0
    finally:
        _release_lock(lock)

    # summarize to stderr
    from collections import Counter
    by_new = Counter(c[5] for c in changes)
    pos_changes = [c for c in changes if c[5] in POSITIVE]
    log(f"[scan-followups] changes: {dict(by_new)}  (positive: {len(pos_changes)})")
    if args.verbose:
        for _, company, role, url, old, new, subj, edate in changes:
            log(f"    {company} : {old or 'pending'} -> {new}"
                + (f"   [{subj} | {edate}]" if subj else ""))

    need_migrate = FOLLOWUP_COL not in header   # first run adds the column even with 0 changes
    if not args.dry_run:
        if changes or need_migrate:
            write_tracker(data)
            why = []
            if need_migrate:
                why.append("added followup_status column")
            if changes:
                why.append(f"{len(changes)} status changes")
            log(f"[scan-followups] tracker.csv written ({'; '.join(why)}); backup tracker.csv.bak-followups")
        else:
            log("[scan-followups] no changes; tracker.csv untouched")
    else:
        log(f"[scan-followups] DRY-RUN: tracker.csv not written (migrate={need_migrate})")

    digest = build_digest(changes)
    if digest:
        print(digest)  # STDOUT = the print-only outcome digest
    else:
        log("[scan-followups] no reportable changes (positives/rejections); stdout empty (silent)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
