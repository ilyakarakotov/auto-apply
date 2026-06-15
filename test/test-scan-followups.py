#!/usr/bin/env python3
"""Unit tests for the scan-followups classifier + company matcher. No network — pure functions only.

Run:  python3 test/test-scan-followups.py
Exit 0 = all pass. These lock in the two things that are easy to get wrong: (a) auto-ack
confirmations must NOT read as outcomes, and (b) real recruiter emails MUST be detected.
"""
import importlib.util
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("sf", os.path.join(ROOT, "src", "scan-followups.py"))
sf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sf)


def score(company, frm, subject, body):
    """Mirror how run() builds the match inputs, then call match_score."""
    comp = sf.compile_company(company)
    strong = (frm + " \n " + subject).lower()
    bl = body.lower()
    return sf.match_score(comp, strong, bl,
                          re.sub(r"[^a-z0-9]", "", strong), re.sub(r"[^a-z0-9]", "", bl))


class TestClassifyRealOutcomes(unittest.TestCase):
    """Real recruiter emails MUST be detected (not suppressed)."""

    def test_interview_calendly(self):
        self.assertEqual(
            sf.classify("Next steps with Stripe — Financial Analyst",
                        "Hi Jane, we enjoyed your application and would like to schedule a call. "
                        "Please pick a time that works: https://calendly.com/stripe/screen"),
            "interview")

    def test_interview_availability(self):
        self.assertEqual(
            sf.classify("Your DigitalOcean application",
                        "We'd like to move forward with an interview. What is your availability next week?"),
            "interview")

    def test_oa_hackerrank(self):
        self.assertEqual(
            sf.classify("Next step: online assessment",
                        "Please complete this HackerRank coding assessment within 3 days. Assessment link: ..."),
            "oa")

    def test_offer(self):
        self.assertEqual(
            sf.classify("Your offer from Acme",
                        "We are pleased to offer you the position of Financial Analyst. Your offer letter is attached."),
            "offer")

    def test_rejection_decisive(self):
        self.assertEqual(
            sf.classify("Update on your application to Acme",
                        "After careful consideration, we have decided not to move forward with your application."),
            "rejection")

    def test_rejection_overrides_ack_subject(self):
        self.assertEqual(
            sf.classify("Thank you for applying to Acme",
                        "Unfortunately we will not be moving forward with your application at this time."),
            "rejection")


class TestClassifyAutoAcks(unittest.TestCase):
    """Auto-acknowledgements MUST be suppressed (these are real inbox bodies)."""

    def test_ack_thank_you_applying(self):
        self.assertIsNone(
            sf.classify("Thank you for applying to DigitalOcean!",
                        "Thanks for applying! We will reach out within two to three weeks to schedule a call."))

    def test_ack_not_selected_boilerplate(self):
        self.assertIsNone(
            sf.classify("Thank you for applying to Bitwarden",
                        "If you are not selected for this position, please keep an eye on our careers page."))

    def test_ack_conditional_interview(self):
        self.assertIsNone(
            sf.classify("Your application has been received by Sagent's Talent Team!",
                        "We'll be in touch in the short term if we'd like to schedule an interview."))

    def test_ack_nice_to_meet_you(self):
        self.assertIsNone(
            sf.classify("Nice to meet you & next steps",
                        "We will be in touch if we'd like to schedule an interview."))

    def test_ack_process_description(self):
        self.assertIsNone(
            sf.classify("Thank you for applying to Tebra",
                        "Our process includes phone calls, case studies or challenges, and video interviews."))

    def test_ack_security_code(self):
        self.assertIsNone(
            sf.classify("Security code for your application to Nutrafol", "Your code is AB12cdEF"))

    def test_ack_hedged_no_ack_subject(self):
        self.assertIsNone(
            sf.classify("Regarding your application",
                        "If your qualifications match, a recruiter may reach out to schedule a call."))


class TestMatchScore(unittest.TestCase):
    """Identity must be in From/Subject; no body cross-match for single tokens."""

    def test_match_from_domain(self):
        self.assertEqual(score("DigitalOcean", "talent@digitalocean.com", "Your application", ""), 1)

    def test_match_subject(self):
        self.assertEqual(score("SimplePractice", "no-reply@us.greenhouse-mail.io",
                               "Thank you for applying to SimplePractice", ""), 1)

    def test_match_multiword_body(self):
        self.assertEqual(score("Human Interest", "no-reply@us.greenhouse-mail.io",
                               "Next steps", "your application to Human Interest is progressing"), 1)

    def test_nomatch_single_token_body_only(self):
        # 'unity' in a body must NOT cross-match
        self.assertEqual(score("Unity Technologies", "no-reply@us.greenhouse-mail.io",
                               "Thank you for applying to SimplePractice", "we value unity and teamwork"), 0)

    def test_nomatch_unrelated(self):
        self.assertEqual(score("Persona", "no-reply@us.greenhouse-mail.io",
                               "Thank you for applying to Wasabi Technologies",
                               "thanks for applying to wasabi"), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
