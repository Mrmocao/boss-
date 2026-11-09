"""Offline regression tests for the recruiting configuration validator."""
import contextlib
import copy
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("recruiting_config_validator", ROOT / "scripts/validate_recruiting_config.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class RecruitingConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.job_path = self.root / "config/jobs/game-execution-planner.yaml"
        self.msg_path = self.root / "config/messages/game-execution-planner.yaml"
        self.job_path.parent.mkdir(parents=True)
        self.msg_path.parent.mkdir(parents=True)
        self.job = yaml.safe_load(validator.DEFAULT_JOB.read_text(encoding="utf-8-sig"))
        self.messages = yaml.safe_load(validator.DEFAULT_MESSAGES.read_text(encoding="utf-8-sig"))
        self.root_patch = patch.object(validator, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def write(self):
        self.job_path.write_text(yaml.safe_dump(self.job, allow_unicode=True), encoding="utf-8")
        self.msg_path.write_text(yaml.safe_dump(self.messages, allow_unicode=True), encoding="utf-8")

    def validate(self):
        self.write()
        return validator.validate_config(self.job_path, self.msg_path)

    def ready_fixture(self):
        self.job["job"]["status"] = "approved"
        ex = self.job["execution"]
        ex["mode"] = "automatic"
        ex["send_messages"] = True
        ex["reject_attachment_requests"] = True
        ex["verified_capabilities"] = copy.deepcopy(ex["required_capabilities"])
        self.job["collection"]["attachment_source"] = "exclude_all_attachments"
        self.job["screening"]["rules"][0]["education_matching"] = "same_education_record"
        self.job["attachments"]["policy_status"] = "approved"
        self.job["questionnaire"].update(fixed_url="https://recruiting.test/forms/game-planner", link_status="verified", receipt_mode="manual_confirmation")
        for message in self.messages["messages"].values():
            message["status"] = "approved"
        self.job["open_questions"] = []

    def test_current_draft_is_valid_but_not_ready(self):
        result = self.validate()
        self.assertTrue(result["structure_valid"], result["errors"])
        self.assertFalse(result["execution_ready"])
        self.assertTrue(any("当前模式" in x for x in result["execution_blockers"]))

    def test_complete_fixture_is_ready_without_executing_any_action(self):
        self.ready_fixture()
        self.assertEqual(self.validate()["execution_blockers"], [])
        self.assertTrue(self.validate()["execution_ready"])

    def test_schema_version_and_required_fields(self):
        self.job["schema_version"] = True
        del self.job["collection"]
        result = self.validate()
        self.assertFalse(result["structure_valid"])
        self.assertTrue(any("schema_version" in x for x in result["errors"]))
        self.assertTrue(any("collection" in x for x in result["errors"]))

    def test_duplicate_whitelist_across_categories_is_rejected(self):
        whitelist = self.job["screening"]["rules"][1]["whitelist"]
        whitelist["engineering"].append(whitelist["computer"][0])
        result = self.validate()
        self.assertFalse(result["structure_valid"])
        self.assertTrue(any("跨分类重复" in x for x in result["errors"]))

    def test_undefined_information_reference_is_rejected(self):
        self.job["screening"]["rules"][0]["field"] = "undeclared_field"
        result = self.validate()
        self.assertFalse(result["structure_valid"])
        self.assertTrue(any("未定义" in x for x in result["errors"]))

    def test_undefined_message_reference_is_rejected(self):
        self.job["workflow"]["test_message"] = "DOES_NOT_EXIST"
        self.assertFalse(self.validate()["structure_valid"])

    def test_unknown_transition_timeout_and_receipt_states_are_rejected(self):
        self.job["workflow"]["transitions"][0]["to"] = "missing_state"
        self.job["workflow"]["timeout_outcomes"]["waiting_consent"] = "missing_state"
        self.job["questionnaire"]["complete_files_state"] = "missing_state"
        result = self.validate()
        self.assertFalse(result["structure_valid"])
        self.assertTrue(any("transitions" in x for x in result["errors"]))
        self.assertTrue(any("timeout_outcomes" in x for x in result["errors"]))
        self.assertTrue(any("complete_files_state" in x for x in result["errors"]))

    def test_duplicate_transition_and_nonterminal_attachment_state_are_rejected(self):
        self.job["workflow"]["transitions"].append(copy.deepcopy(self.job["workflow"]["transitions"][0]))
        self.job["workflow"]["terminal_policy"]["attachment_rejection_states"] = ["screening"]
        result = self.validate()
        self.assertFalse(result["structure_valid"])
        self.assertTrue(any("重复定义" in x for x in result["errors"]))
        self.assertTrue(any("必须引用终态" in x for x in result["errors"]))

    def test_before_test_guidance_must_be_a_candidate_message(self):
        self.job["attachments"]["before_test_guidance_message"] = "S5"
        self.assertFalse(self.validate()["structure_valid"])

    def test_internal_handoff_cannot_be_used_as_candidate_message(self):
        self.job["workflow"]["test_message"] = "S5"
        result = self.validate()
        self.assertTrue(any("不能混用" in x for x in result["errors"]))

    def test_candidate_message_cannot_be_used_as_internal_handoff(self):
        self.job["workflow"]["handoff_message"] = "S1"
        self.assertFalse(self.validate()["structure_valid"])

    def test_unrecognized_audience_and_status_are_rejected(self):
        self.messages["messages"]["S1"].update(audience="anyone", status="ready_maybe")
        result = self.validate()
        self.assertFalse(result["structure_valid"])
        self.assertTrue(any("audience" in x for x in result["errors"]))
        self.assertTrue(any("status" in x for x in result["errors"]))

    def test_unknown_undeclared_and_malformed_variables_are_rejected(self):
        for text in ("{SECRET}", "{EMAIL", "{任意变量}", "{{EMAIL}}"):
            with self.subTest(text=text):
                self.messages["messages"]["S1"]["text"] = text
                self.assertFalse(self.validate()["structure_valid"])

    def test_unsupported_variable_declaration_is_rejected(self):
        self.messages["variables"].append("SECRET")
        self.assertFalse(self.validate()["structure_valid"])

    def test_proposed_revision_blocks_ready_even_after_job_approved(self):
        self.ready_fixture()
        self.messages["messages"]["S4"]["status"] = "proposed_revision"
        result = self.validate()
        self.assertTrue(result["structure_valid"])
        self.assertFalse(result["execution_ready"])

    def test_pending_marker_blocks_even_if_open_questions_cleared(self):
        self.ready_fixture()
        self.job["screening"]["rules"][0]["education_matching"] = "review_pending"
        result = self.validate()
        self.assertTrue(result["structure_valid"])
        self.assertFalse(result["execution_ready"])

    def test_missing_capability_blocks_ready(self):
        self.ready_fixture()
        self.job["execution"]["verified_capabilities"].remove("message_receipt")
        result = self.validate()
        self.assertTrue(result["structure_valid"])
        self.assertFalse(result["execution_ready"])
        self.assertTrue(any("message_receipt" in x for x in result["execution_blockers"]))

    def test_missing_link_blocks_and_fake_or_unsafe_links_are_errors(self):
        self.ready_fixture()
        self.job["questionnaire"]["fixed_url"] = None
        self.assertFalse(self.validate()["execution_ready"])
        for url in ("http://recruiting.test/form", "https://example.com/form", "https://form.invalid", "https://user:secret@recruiting.test/form", "https://recruiting.test/{TEST_LINK}", "https://["):
            with self.subTest(url=url):
                self.job["questionnaire"]["fixed_url"] = url
                self.assertFalse(self.validate()["structure_valid"])

    def test_read_only_mode_rejects_write_flags(self):
        self.job["execution"]["mode"] = "read_only"
        self.job["execution"]["send_messages"] = True
        self.assertFalse(self.validate()["structure_valid"])

    def test_duplicate_yaml_keys_fail_instead_of_silent_overwrite(self):
        self.write()
        with self.msg_path.open("a", encoding="utf-8") as handle:
            handle.write("\nschema_version: 1\n")
        result = validator.validate_config(self.job_path, self.msg_path)
        self.assertFalse(result["structure_valid"])
        self.assertTrue(any("Duplicate YAML key" in x for x in result["errors"]))

    def test_malformed_enum_types_return_errors_not_exceptions(self):
        self.job["execution"]["mode"] = {}
        self.job["questionnaire"]["link_status"] = []
        self.messages["messages"]["S1"]["status"] = {}
        self.assertFalse(self.validate()["structure_valid"])

    def test_cli_check_ready_exit_code(self):
        self.write()
        arguments = ["--job", str(self.job_path), "--messages", str(self.msg_path)]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(validator.main(arguments), 0)
            self.assertEqual(validator.main(arguments + ["--check-ready"]), 1)
        self.ready_fixture()
        self.write()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(validator.main(arguments + ["--check-ready"]), 0)


if __name__ == "__main__":
    unittest.main()
