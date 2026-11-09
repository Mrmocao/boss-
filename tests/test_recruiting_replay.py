"""Offline workflow acceptance tests: synthetic inputs, no external actions."""
import copy
import hashlib
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import replay_recruiting_workflow as replay


class ReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config, cls.messages, cls.validation = replay.load_inputs()

    def simulation(self, facts=None, link=False):
        return replay.Simulation(self.config, self.messages, facts if facts is not None else replay.qualifying(), link)

    def test_acceptance_cases_all_pass_with_zero_external_actions(self):
        cases = replay.run_scenarios(self.config, self.messages)
        self.assertGreaterEqual(len(cases), 25)
        for case in cases:
            with self.subTest(case=case['name']):
                self.assertTrue(case['passed'], case['failure'])
                self.assertTrue(case['assertions'])
                self.assertTrue(all(item['simulation'] for item in case['trace']))
                self.assertEqual(sum(case['real_actions'].values()), 0)

    def test_same_education_record_required_and_unknown_records_prevent_false_rejection(self):
        facts = replay.qualifying(education_records=[replay.record('专科', '软件工程'), replay.record('本科', '法学', category='法学', category_confirmed=True)])
        self.assertEqual(replay.screen(self.config, facts)['outcome'], 'explicit_unmet')
        facts['education_records'].append({'level': '硕士', 'evidence': '尚缺专业'})
        self.assertEqual(replay.screen(self.config, facts)['outcome'], 'missing')
        facts['education_records'][-1] = replay.record('硕士', '计算机科学与技术')
        self.assertEqual(replay.screen(self.config, facts)['outcome'], 'passed')

    def test_whitelist_exact_match_has_priority_over_a_noisy_category(self):
        facts = replay.qualifying(education_records=[replay.record(major='金融数学', category='管理', category_confirmed=True)])
        self.assertEqual(replay.screen(self.config, facts)['outcome'], 'passed')
        facts['education_records'][0]['major'] = '软件工程相关'
        facts['education_records'][0].pop('category_confirmed')
        self.assertEqual(replay.screen(self.config, facts)['outcome'], 'human_review')

    def test_intent_requires_explicit_fact_and_original_evidence(self):
        for intent in ({}, {'status': 'confirmed', 'value': True}, {'status': 'inferred', 'value': True, 'evidence': '曾做过策划'}):
            with self.subTest(intent=intent):
                self.assertEqual(replay.screen(self.config, replay.qualifying(planning_intent=intent))['outcome'], 'missing')
        intent = {'status': 'confirmed', 'value': False, 'evidence': '不希望做游戏策划'}
        self.assertEqual(replay.screen(self.config, replay.qualifying(planning_intent=intent))['outcome'], 'explicit_unmet')

    def test_stage_and_missing_evidence_are_not_guessed(self):
        for degree in [replay.record(stage='studying', year=1), replay.record('硕士', stage='studying'), replay.record('学士')]:
            self.assertEqual(replay.screen(self.config, replay.qualifying(education_records=[degree]))['outcome'], 'human_review')
        degree = replay.record(evidence='')
        self.assertEqual(replay.screen(self.config, replay.qualifying(education_records=[degree]))['outcome'], 'missing')

    def test_true_config_link_block_cannot_be_bypassed_by_fake_receipt(self):
        s = self.simulation()
        replay.reach_consent(s)
        s.event('yes', 'consent', answer='yes', in_reply_to='S1')
        self.assertNotIn('S3', s.intents)
        s.event('receipt', 'receipt', message='S3')
        self.assertEqual(s.state, 'test_pending')

    def test_config_is_unchanged_after_simulation_and_report_stays_unready(self):
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (replay.DEFAULT_JOB, replay.DEFAULT_MESSAGES)}
        config_copy = copy.deepcopy(self.config)
        report = replay.build_report()
        self.assertEqual(self.config, config_copy)
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in before})
        self.assertFalse(report['production_readiness']['execution_ready'])
        self.assertEqual(report['mode'], 'simulation_only')
        self.assertIsNone(self.config['questionnaire']['fixed_url'])

    def test_configured_timeout_value_is_consumed_not_hardcoded(self):
        config = copy.deepcopy(self.config)
        config['workflow']['timeouts']['consent_hours'] = 7
        s = replay.Simulation(config, self.messages, replay.qualifying())
        replay.reach_consent(s)
        s.event('six', 'clock', hours=6)
        self.assertEqual(s.state, 'waiting_consent')
        s.event('seven', 'clock', hours=1)
        self.assertEqual(s.state, 'lost')

    def test_invalid_receipt_and_repeated_receipt_do_not_advance_or_restart_timer(self):
        s = self.simulation()
        s.event('wrong', 'receipt', message='S1')
        self.assertEqual(s.state, 'screening')
        replay.reach_consent(s)
        s.event('advance', 'clock', hours=70)
        s.event('duplicate_receipt_new_id', 'receipt', message='S1')
        self.assertEqual(s.wait_since, 0)
        s.event('deadline', 'clock', hours=2)
        self.assertEqual(s.state, 'lost')

    def test_send_unknown_freezes_future_actions_and_does_not_retry(self):
        s = self.simulation()
        s.event('screen', 'screen')
        s.event('unknown', 'receipt', message='S1', result='unknown')
        for index, kind in enumerate(('screen', 'clock', 'attachment')):
            s.event(str(index), kind, hours=80, request_id='attachment')
        self.assertEqual(s.state, 'human_review')
        self.assertEqual(len(s.drafts), 1)
        self.assertEqual(s.hour, 0)
        self.assertFalse(s.attachments)

    def test_mail_requires_identity_job_and_test_send_event(self):
        for key, value in [('candidate_id', 'wrong'), ('job_id', 'wrong'), ('send_event', 'wrong'), ('verified', False)]:
            s = self.simulation(link=True)
            replay.reach_email(s)
            data = replay.mail_data(s, ['questionnaire', 'resume'])
            data[key] = value
            s.event('mail', 'mail_receipt', **data)
            self.assertEqual(s.state, 'human_review')

    def test_actual_fact_does_not_recursively_expand_template_variables(self):
        s = self.simulation()
        s.draft('S4', REASON='{TEST_LINK} <script>文本</script>')
        self.assertIn('{TEST_LINK}', s.drafts[-1]['text'])
        self.assertEqual(s.drafts[-1]['result'], 'draft_only')

    def test_configuration_transition_is_authoritative(self):
        config = copy.deepcopy(self.config)
        config['workflow']['transitions'] = [x for x in config['workflow']['transitions'] if x['event'] != 'all_rules_pass']
        s = replay.Simulation(config, self.messages, replay.qualifying())
        with self.assertRaisesRegex(ValueError, 'No configured transition'):
            s.event('screen', 'screen')


if __name__ == '__main__':
    unittest.main()
