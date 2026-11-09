"""Validate recruiting YAML structure separately from execution readiness.

This command only reads local configuration. It never opens a browser or sends messages.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlparse

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_JOB = ROOT / "config/jobs/game-execution-planner.yaml"
DEFAULT_MESSAGES = ROOT / "config/messages/game-execution-planner.yaml"
VARIABLES = {"TEST_LINK", "EMAIL", "NAME", "REASON", "MSG", "MISSING_FIELDS"}
MESSAGE_STATUSES = {"source_document", "proposed_revision", "proposed_addition", "approved", "draft", "review_pending", "retired"}


class UniqueKeyLoader(yaml.SafeLoader):
    """Reject duplicate YAML keys instead of silently accepting the last value."""


def _unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, (str, int, float, bool, type(None))):
            raise ValueError("YAML mapping keys must be scalar values")
        if key in result:
            raise ValueError(f"Duplicate YAML key: {key!r}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _unique_mapping)


def validate_config(job_path=DEFAULT_JOB, messages_path=DEFAULT_MESSAGES):
    errors, blockers = [], []

    def error(path, message):
        errors.append(f"{path}: {message}")

    def block(path, message):
        blockers.append(f"{path}: {message}")

    def load(path):
        try:
            data = yaml.load(Path(path).read_text(encoding="utf-8-sig"), Loader=UniqueKeyLoader)
            if not isinstance(data, dict):
                raise ValueError("顶层必须是对象")
            return data
        except (OSError, yaml.YAMLError, ValueError, TypeError) as exc:
            error(str(path), f"读取或解析失败：{exc}")
            return {}

    def mapping(parent, key, required=()):
        value = parent.get(key)
        if not isinstance(value, dict):
            error(key, "必须是对象")
            return {}
        for name in required:
            if name not in value:
                error(f"{key}.{name}", "缺少必需字段")
        return value

    def enum(value, allowed, path):
        if not isinstance(value, str) or value not in allowed:
            error(path, f"取值必须属于 {', '.join(sorted(allowed))}")

    def boolean(value, path):
        if type(value) is not bool:
            error(path, "必须为 true 或 false")

    def string(value, path):
        if not isinstance(value, str) or not value.strip():
            error(path, "必须是非空字符串")

    def string_list(value, path, nonempty=False):
        if not isinstance(value, list) or any(not isinstance(x, str) or not x.strip() for x in value):
            error(path, "必须为非空字符串组成的列表")
            return []
        if nonempty and not value:
            error(path, "列表不能为空")
        if len(set(value)) != len(value):
            error(path, "列表存在重复值")
        return value

    def integer(value, path, allow_null=False):
        if allow_null and value is None:
            return
        if type(value) is not int or value < 0:
            error(path, "必须为非负整数" + ("或 null" if allow_null else ""))

    job_doc, msg_doc = load(job_path), load(messages_path)
    for label, doc in (("job", job_doc), ("messages", msg_doc)):
        if type(doc.get("schema_version")) is not int or doc.get("schema_version") != 1:
            error(f"{label}.schema_version", "必须为整数 1")

    job = mapping(job_doc, "job", ("id", "name", "version", "status", "source", "messages_file"))
    for key in ("id", "name", "source", "messages_file"):
        string(job.get(key), f"job.{key}")
    integer(job.get("version"), "job.version")
    if job.get("version") == 0:
        error("job.version", "必须大于0")
    enum(job.get("status"), {"draft", "review_pending", "approved", "retired"}, "job.status")
    if job.get("status") != "approved":
        block("job.status", "岗位规则尚未批准")
    if msg_doc.get("job_id") != job.get("id"):
        error("messages.job_id", "必须与岗位 job.id 一致")
    if isinstance(job.get("messages_file"), str):
        declared = Path(job["messages_file"])
        if declared.is_absolute() or ".." in declared.parts:
            error("job.messages_file", "必须是项目内相对路径")
        elif (ROOT / declared).resolve() != Path(messages_path).resolve():
            error("job.messages_file", "引用路径与实际校验的话术文件不一致")

    offer = mapping(job_doc, "offer", ("city", "salary_text", "salary_basis", "level", "accept_fresh_graduates", "experience_required"))
    for key in ("city", "salary_text", "level"):
        string(offer.get(key), f"offer.{key}")
    for key in ("accept_fresh_graduates", "experience_required"):
        boolean(offer.get(key), f"offer.{key}")

    execution = mapping(job_doc, "execution", ("mode", "send_messages", "reject_attachment_requests", "read_mailbox", "required_capabilities", "verified_capabilities"))
    enum(execution.get("mode"), {"read_only", "draft_only", "automatic"}, "execution.mode")
    for key in ("send_messages", "reject_attachment_requests", "read_mailbox"):
        boolean(execution.get(key), f"execution.{key}")
    if execution.get("mode") != "automatic" or execution.get("send_messages") is not True:
        block("execution", "当前模式不允许自动发送")
    if execution.get("mode") in ("read_only", "draft_only") and any(execution.get(k) is True for k in ("send_messages", "reject_attachment_requests", "read_mailbox")):
        error("execution", "只读/草稿模式不能开启发送、拒收附件或邮箱读取动作")
    required_caps = string_list(execution.get("required_capabilities"), "execution.required_capabilities", True)
    verified_caps = string_list(execution.get("verified_capabilities"), "execution.verified_capabilities")
    for capability in required_caps:
        if capability not in verified_caps:
            block("execution.verified_capabilities", f"尚未验收能力 {capability}")

    information = mapping(job_doc, "information")
    if not information:
        error("information", "至少需要一个采集字段")
    for field, spec in information.items():
        if not isinstance(spec, dict):
            error(f"information.{field}", "必须是对象")
            continue
        string(spec.get("name"), f"information.{field}.name")
        boolean(spec.get("required"), f"information.{field}.required")

    collection = mapping(job_doc, "collection", ("sources", "attachment_source", "save_evidence", "skip_answered", "clarification_limit", "clarification_message", "clarification_intent_message", "incomplete_reply", "conflicting_evidence"))
    string_list(collection.get("sources"), "collection.sources", True)
    for key in ("save_evidence", "skip_answered"):
        boolean(collection.get(key), f"collection.{key}")
    integer(collection.get("clarification_limit"), "collection.clarification_limit")
    for key in ("incomplete_reply", "conflicting_evidence"):
        enum(collection.get(key), {"human_review"}, f"collection.{key}")

    screening = mapping(job_doc, "screening", ("mode", "experience_gate", "optional_affects_result", "rules", "outcomes"))
    enum(screening.get("mode"), {"all_required"}, "screening.mode")
    for key in ("experience_gate", "optional_affects_result"):
        boolean(screening.get(key), f"screening.{key}")
    rules = screening.get("rules", [])
    if not isinstance(rules, list) or not rules:
        error("screening.rules", "必须是非空规则列表")
        rules = []
    ids, white_seen = set(), set()
    for rule in rules:
        if not isinstance(rule, dict):
            error("screening.rules", "每条规则必须是对象")
            continue
        rid = rule.get("id")
        string(rid, "screening.rules.id")
        if isinstance(rid, str):
            if rid in ids:
                error("screening.rules", f"重复规则ID {rid}")
            ids.add(rid)
        field = rule.get("field")
        if not isinstance(field, str) or field not in information:
            error(f"screening.{rid}.field", "引用了未定义的采集字段")
        string(rule.get("criterion"), f"screening.{rid}.criterion")
        if "whitelist" in rule:
            whitelist = rule["whitelist"]
            if not isinstance(whitelist, dict) or not whitelist:
                error(f"screening.{rid}.whitelist", "必须是非空分类对象")
                continue
            for category, majors in whitelist.items():
                for major in string_list(majors, f"screening.{rid}.whitelist.{category}", True):
                    normalized = major.strip()
                    if normalized in white_seen:
                        error(f"screening.{rid}.whitelist", f"跨分类重复专业：{major}")
                    white_seen.add(normalized)
    outcomes = mapping(screening, "outcomes", ("passed", "explicit_unmet", "missing", "ambiguous", "conflict"))
    for key, allowed in {"passed": {"invite_questionnaire"}, "explicit_unmet": {"rejection_draft", "human_review"}, "missing": {"clarify_once"}, "ambiguous": {"human_review"}, "conflict": {"human_review"}}.items():
        enum(outcomes.get(key), allowed, f"screening.outcomes.{key}")

    workflow = mapping(job_doc, "workflow", ("trigger", "priority", "initial_state", "states", "terminal_states", "terminal_policy", "transitions", "timeout_outcomes", "consent_message", "test_message", "rejection_message", "refusal_message", "handoff_message", "timer_start", "timeouts", "reminders", "consent", "human_takeover_pauses_actions_and_timers"))
    string_list(workflow.get("priority"), "workflow.priority", True)
    states = string_list(workflow.get("states"), "workflow.states", True)
    terminal = string_list(workflow.get("terminal_states"), "workflow.terminal_states", True)
    def state_ref(value, path):
        if not isinstance(value, str) or value not in states:
            error(path, "引用了未定义的流程状态")
    state_ref(workflow.get("initial_state"), "workflow.initial_state")
    for state in terminal:
        state_ref(state, "workflow.terminal_states")
    terminal_policy = mapping(workflow, "terminal_policy", ("candidate_messages", "attachment_rejection_states", "other_terminal_attachment", "do_not_contact"))
    enum(terminal_policy.get("candidate_messages"), {"none"}, "workflow.terminal_policy.candidate_messages")
    for state in string_list(terminal_policy.get("attachment_rejection_states"), "workflow.terminal_policy.attachment_rejection_states"):
        if state not in terminal:
            error("workflow.terminal_policy.attachment_rejection_states", "必须引用终态")
    transitions = workflow.get("transitions")
    if not isinstance(transitions, list) or not transitions:
        error("workflow.transitions", "必须是非空列表")
        transitions = []
    transition_events = set()
    for index, transition in enumerate(transitions):
        path = f"workflow.transitions[{index}]"
        if not isinstance(transition, dict):
            error(path, "必须是对象")
            continue
        state_ref(transition.get("from"), f"{path}.from")
        state_ref(transition.get("to"), f"{path}.to")
        string(transition.get("event"), f"{path}.event")
        if all(isinstance(transition.get(k), str) for k in ("from", "event")):
            key = (transition["from"], transition["event"])
            if key in transition_events:
                error(path, "同一来源状态与事件不能重复定义转换")
            transition_events.add(key)
    timeout_outcomes = mapping(workflow, "timeout_outcomes")
    for state, destination in timeout_outcomes.items():
        state_ref(state, "workflow.timeout_outcomes")
        state_ref(destination, f"workflow.timeout_outcomes.{state}")
    enum(workflow.get("timer_start"), {"confirmed_message_receipt"}, "workflow.timer_start")
    integer(workflow.get("reminders"), "workflow.reminders")
    timeouts = mapping(workflow, "timeouts", ("clarification_hours", "consent_hours", "submitted_test_hours"))
    for key, value in timeouts.items():
        integer(value, f"workflow.timeouts.{key}", True)
    boolean(workflow.get("human_takeover_pauses_actions_and_timers"), "workflow.human_takeover_pauses_actions_and_timers")
    mapping(workflow, "consent", ("positive", "negative", "temporary_busy", "ambiguous"))

    attachments = mapping(job_doc, "attachments", ("requested_action", "guidance_message", "before_test_guidance_message", "policy_status", "handoff_behavior", "deduplicate_by"))
    enum(attachments.get("policy_status"), {"draft", "review_pending", "approved", "disabled"}, "attachments.policy_status")
    if attachments.get("policy_status") not in ("approved", "disabled"):
        block("attachments.policy_status", "附件策略尚未确认")
    if attachments.get("requested_action") == "reject_request" and execution.get("reject_attachment_requests") is not True:
        block("execution.reject_attachment_requests", "附件拒收流程未启用")

    questionnaire = mapping(job_doc, "questionnaire", ("name", "format", "fixed_url", "link_status", "deadline_hours", "reminders", "collection_email", "required_files", "receipt_mode", "chat_claim_is_receipt"))
    enum(questionnaire.get("link_status"), {"missing", "review_pending", "unverified", "verified", "approved", "expired"}, "questionnaire.link_status")
    url = questionnaire.get("fixed_url")
    if url is None:
        block("questionnaire.fixed_url", "缺少固定问卷链接")
    elif not isinstance(url, str):
        error("questionnaire.fixed_url", "必须是 HTTPS 字符串或 null")
    else:
        try:
            parsed = urlparse(url)
        except ValueError:
            parsed = urlparse("")
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or "{" in url or "}" in url:
            error("questionnaire.fixed_url", "必须是真实 HTTPS 链接，不能含账号密码或占位符")
        if parsed.hostname in {"example.com", "example.org", "example.net", "localhost"} or (parsed.hostname or "").endswith(".invalid"):
            error("questionnaire.fixed_url", "不能使用示例或占位域名")
    if questionnaire.get("link_status") not in ("verified", "approved"):
        block("questionnaire.link_status", "问卷链接未确认有效")
    email = questionnaire.get("collection_email")
    if not isinstance(email, str) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        error("questionnaire.collection_email", "邮箱格式无效")
    string_list(questionnaire.get("required_files"), "questionnaire.required_files", True)
    integer(questionnaire.get("deadline_hours"), "questionnaire.deadline_hours", True)
    integer(questionnaire.get("reminders"), "questionnaire.reminders")
    boolean(questionnaire.get("chat_claim_is_receipt"), "questionnaire.chat_claim_is_receipt")
    for key in ("partial_files_state", "complete_files_state"):
        state_ref(questionnaire.get(key), f"questionnaire.{key}")

    variables = string_list(msg_doc.get("variables"), "messages.variables")
    for variable in variables:
        if variable not in VARIABLES:
            error("messages.variables", f"不支持的模板变量 {variable}")
    messages = mapping(msg_doc, "messages")
    if not messages:
        error("messages", "至少需要一条话术")
    for mid, message in messages.items():
        if not isinstance(message, dict):
            error(f"messages.{mid}", "必须是对象")
            continue
        enum(message.get("audience"), {"candidate", "internal"}, f"messages.{mid}.audience")
        enum(message.get("status"), MESSAGE_STATUSES, f"messages.{mid}.status")
        if message.get("status") not in ("source_document", "approved"):
            block(f"messages.{mid}.status", "新增或改版话术尚未确认")
        text = message.get("text")
        string(text, f"messages.{mid}.text")
        if isinstance(text, str):
            tokens = re.findall(r"\{([A-Z][A-Z_0-9]*)\}", text)
            for token in tokens:
                if token not in variables:
                    error(f"messages.{mid}.text", f"未声明变量 {token}")
            rest = re.sub(r"\{[A-Z][A-Z_0-9]*\}", "", text)
            if "{" in rest or "}" in rest:
                error(f"messages.{mid}.text", "存在不合法或未闭合的模板变量")

    refs = [("collection", collection, "clarification_message", "candidate"),
            ("collection", collection, "clarification_intent_message", "candidate"),
            ("attachments", attachments, "guidance_message", "candidate"),
            ("attachments", attachments, "before_test_guidance_message", "candidate")]
    refs += [("workflow", workflow, key, "internal" if key == "handoff_message" else "candidate")
             for key in ("consent_message", "test_message", "rejection_message", "refusal_message", "handoff_message")]
    for section, config, key, audience in refs:
        ref = config.get(key)
        if not isinstance(ref, str) or ref not in messages:
            error(f"{section}.{key}", "引用的话术不存在")
        elif isinstance(messages[ref], dict) and messages[ref].get("audience") != audience:
            error(f"{section}.{key}", f"此动作必须引用 {audience} 话术，不能混用内部与候选人通知")

    questions = job_doc.get("open_questions")
    if not isinstance(questions, list):
        error("open_questions", "必须是列表；无待确认项时填 []")
        questions = []
    qids = set()
    for question in questions:
        if not isinstance(question, dict):
            error("open_questions", "每个待确认项必须是对象")
            continue
        qid = question.get("id")
        string(qid, "open_questions.id")
        if isinstance(qid, str):
            if qid in qids:
                error("open_questions.id", f"重复ID {qid}")
            qids.add(qid)
        enum(question.get("status"), {"pending", "resolved", "cancelled"}, f"open_questions.{qid}.status")
        string(question.get("question"), f"open_questions.{qid}.question")
        if question.get("status") == "pending":
            block(f"open_questions.{qid}", "业务问题待确认")

    # Pending markers remain blockers even when somebody accidentally clears open_questions.
    def pending_markers(value, path=""):
        if isinstance(value, dict):
            for key, item in value.items():
                pending_markers(item, f"{path}.{key}" if path else str(key))
        elif isinstance(value, list):
            for index, item in enumerate(value):
                pending_markers(item, f"{path}[{index}]")
        elif isinstance(value, str) and (value == "review_pending" or value == "manual_confirmation_pending"):
            block(path, "配置含尚未确认的值")
    pending_markers(job_doc)
    errors, blockers = list(dict.fromkeys(errors)), list(dict.fromkeys(blockers))
    return {"structure_valid": not errors, "execution_ready": not errors and not blockers,
            "errors": errors, "execution_blockers": blockers,
            "scope": "仅校验本地配置；不执行招聘动作，不证明浏览器/收件/发送能力已真实验收"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", type=Path, default=DEFAULT_JOB)
    parser.add_argument("--messages", type=Path, default=DEFAULT_MESSAGES)
    parser.add_argument("--check-ready", action="store_true", help="结构有效但未具备执行条件时也返回非零")
    args = parser.parse_args(argv)
    report = validate_config(args.job, args.messages)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if not report["structure_valid"] or (args.check_ready and not report["execution_ready"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
