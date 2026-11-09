"""Offline recruiting workflow rehearsal with synthetic facts and receipts only.

Not a production executor, browser adapter, NLP model, mail client or real sender.
No network imports or external actions exist in this module. All output is local.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path

import yaml
from validate_recruiting_config import DEFAULT_JOB, DEFAULT_MESSAGES, ROOT, validate_config

SIMULATED_LINK = "https://simulation.invalid/questionnaire.xlsx"


def load_inputs():
    validation = validate_config()
    if not validation["structure_valid"]:
        raise ValueError("Configuration invalid: " + "; ".join(validation["errors"]))
    return (yaml.safe_load(DEFAULT_JOB.read_text(encoding="utf-8-sig")),
            yaml.safe_load(DEFAULT_MESSAGES.read_text(encoding="utf-8-sig")), validation)


def screen(config, facts):
    """Evaluate only explicit structured synthetic facts; never infer identity/major from prose."""
    rules = {x["id"]: x for x in config["screening"]["rules"]}
    if rules["H1"]["education_matching"] != "same_record_bachelor_or_above":
        return {"outcome": "human_review", "reason": "education_policy_unconfirmed", "missing": []}
    if facts.get("conflict"):
        return {"outcome": "human_review", "reason": "conflicting_evidence", "missing": []}
    missing = []
    rows = facts.get("education_records")
    whitelist = {major for group in rules["H2"]["whitelist"].values() for major in group}
    accepted = set(rules["H1"]["accepted_levels"])
    record_results = []
    for record in rows or []:
        # A record-level evidence string and explicit stage are necessary to judge it.
        if not record.get("evidence") or not record.get("level") or not record.get("major"):
            record_results.append("missing")
            continue
        level, stage = record["level"], record.get("stage")
        if level not in accepted:
            record_results.append("unmet" if level in {"专科", "高中", "中专"} else "ambiguous")
            continue
        if stage == "graduated":
            level_ok = True
        elif level == "本科" and stage == "studying" and record.get("year") in rules["H1"]["accepted_undergraduate_study_years"]:
            level_ok = True
        else:
            # Graduate study / non-final undergraduate status are unspecified; require human review.
            record_results.append("ambiguous")
            continue
        if level_ok and record["major"] in whitelist:
            record_results.append("pass")
        elif (record.get("category_confirmed") is True
              and record.get("category") in rules["H2"]["explicit_excluded_categories"]):
            record_results.append("unmet")
        else:
            record_results.append("ambiguous")
    if not rows:
        missing += ["education_records", "major"]
        education = "missing"
    elif "pass" in record_results:
        education = "pass"
    elif "ambiguous" in record_results:
        education = "ambiguous"
    elif "missing" in record_results or facts.get("education_complete") is not True:
        education = "missing"
        missing += ["education_records", "major"]
    else:
        education = "unmet"
    intent = facts.get("planning_intent", {})
    # 'Hi' or clicking this job is not evidence; explicit fact + original evidence required.
    if intent.get("status") == "conflict":
        intention = "ambiguous"
    elif intent.get("status") == "confirmed" and intent.get("evidence") and type(intent.get("value")) is bool:
        intention = "pass" if intent["value"] else "unmet"
    else:
        intention = "missing"
        missing.append("planning_intent")
    if "ambiguous" in (education, intention):
        outcome, reason = "human_review", "ambiguous_education_or_intent"
    elif "unmet" in (education, intention):
        outcome = "explicit_unmet"
        reason = "本科及以上同一教育经历的学历与专业符合岗位要求" if education == "unmet" else "明确希望从事游戏策划工作"
    elif missing:
        outcome, reason = "missing", "missing_required_facts"
    else:
        outcome, reason = "passed", "all_required_rules_pass"
    return {"outcome": outcome, "reason": reason, "missing": missing,
            "education_pairing": education, "planning_intent": intention, "record_results": record_results}


class Simulation:
    """In-memory state machine. 'receipt' below is always a fabricated simulation event."""
    def __init__(self, config, messages, facts=None, simulated_link=False):
        self.config, self.messages = copy.deepcopy(config), copy.deepcopy(messages["messages"])
        self.facts = copy.deepcopy(facts or {})
        self.state = config["workflow"]["initial_state"]
        self.transitions = {(x["from"], x["event"]): x["to"] for x in config["workflow"]["transitions"]}
        self.hour = 0.0
        self.wait_since = None
        self.clarification_count = 0
        self.events = set()
        self.attachments = set()
        self.intents = {}
        self.drafts = []
        self.trace = []
        self.checks = []
        self.simulated_link = simulated_link
        self.test_receipt_id = None
        self.candidate_id = "synthetic-candidate"
        self.real_actions = {"messages_sent": 0, "attachments_rejected": 0, "mailbox_reads": 0}

    def note(self, event, **details):
        self.trace.append({"simulation": True, "hour": self.hour, "state": self.state, "event": event, **details})

    def check(self, name, condition):
        self.checks.append({"assertion": name, "passed": bool(condition)})
        if not condition:
            raise AssertionError(name)

    def move(self, event):
        new = self.transitions.get((self.state, event))
        if not new:
            raise ValueError(f"No configured transition: {self.state}/{event}")
        old, self.state = self.state, new
        self.wait_since = self.hour if new in {"waiting_clarification", "waiting_consent"} else None
        self.note(event, previous_state=old)

    def handoff(self, reason):
        old = self.state
        self.state = "human_review"
        self.wait_since = None
        self.note("human_handoff", reason=reason, previous_state=old, audience="internal")

    def draft(self, mid, **values):
        if mid in self.intents:
            self.note("intent_already_exists", message=mid, result=self.intents[mid]["result"])
            return
        variables = {"NAME": "虚构候选人", "EMAIL": self.config["questionnaire"]["collection_email"],
                     "REASON": "需人工确认", "MSG": "虚构消息", **values}
        if mid == self.config["workflow"]["test_message"]:
            url = self.config["questionnaire"]["fixed_url"]
            verified = self.config["questionnaire"]["link_status"] in {"verified", "approved"}
            if self.simulated_link:
                url, verified = SIMULATED_LINK, True
            if not url or not verified:
                self.note("blocked_missing_or_unverified_real_link", message=mid)
                return
            variables["TEST_LINK"] = url
        text = self.messages[mid]["text"]
        tokens = re.findall(r"\{([A-Z_]+)\}", text)
        if any(token not in variables for token in tokens):
            raise ValueError("Unresolved template variables")
        # One substitution pass: candidate-supplied text cannot inject recursively expanded variables.
        rendered = re.sub(r"\{([A-Z_]+)\}", lambda m: str(variables[m[1]]), text)
        intent = {"id": f"sim:{self.candidate_id}:{mid}", "message": mid, "result": "draft_only",
                  "text": rendered, "simulation": True, "audience": self.messages[mid]["audience"]}
        self.intents[mid] = intent
        self.drafts.append(copy.deepcopy(intent))
        self.note("draft_created", message=mid, simulated_link_override=self.simulated_link and mid == "S3")

    def evaluate(self):
        decision = screen(self.config, self.facts)
        self.note("screening_observation", decision=decision)
        outcome = decision["outcome"]
        if outcome == "human_review":
            self.handoff(decision["reason"])
        elif outcome == "missing":
            if self.clarification_count >= self.config["collection"]["clarification_limit"]:
                self.handoff("clarification_budget_exhausted")
                return
            self.move("missing_first_time")
            mid = self.config["collection"]["clarification_intent_message"] if decision["missing"] == ["planning_intent"] else self.config["collection"]["clarification_message"]
            labels = [self.config["information"][x]["name"] for x in decision["missing"]]
            self.draft(mid, MISSING_FIELDS="、".join(labels))
        elif outcome == "explicit_unmet":
            self.move("explicit_rule_unmet")
            self.draft(self.config["workflow"]["rejection_message"], REASON=decision["reason"])
        else:
            self.move("all_rules_pass")
            self.draft(self.config["workflow"]["consent_message"])

    def event(self, event_id, kind, **data):
        if event_id in self.events:
            self.note("duplicate_event_ignored", event_id=event_id)
            return
        self.events.add(event_id)
        if kind == "stop_contact":
            self.state, self.wait_since = "do_not_contact", None
            self.note(kind)
            return
        if self.state in {"human_review", "do_not_contact"}:
            self.note("paused_no_action", kind=kind)
            return
        if kind in {"salary_question", "platform_error", "identity_mismatch", "complaint"}:
            self.handoff(kind)
            return
        if self.state in self.config["workflow"]["terminal_states"]:
            if kind == "attachment" and self.state in self.config["workflow"]["terminal_policy"]["attachment_rejection_states"]:
                if data["request_id"] not in self.attachments:
                    self.attachments.add(data["request_id"])
                    self.note("attachment_rejection_intent_only", no_guidance=True)
            elif kind != "clock":
                self.handoff("late_terminal_event")
            return
        if kind == "attachment":
            rid = data["request_id"]
            if rid in self.attachments:
                self.note("duplicate_attachment_ignored")
                return
            self.attachments.add(rid)
            self.note("attachment_rejection_intent_only", policy_unconfirmed=self.config["attachments"]["policy_status"] != "approved")
            mid = self.config["attachments"]["guidance_message"] if self.test_receipt_id else self.config["attachments"]["before_test_guidance_message"]
            self.draft(mid)
            return
        if kind == "screen":
            if self.state != "screening":
                self.note("screen_ignored_wrong_stage")
                return
            self.evaluate()
        elif kind == "receipt":
            mid = data["message"]
            intent = self.intents.get(mid)
            if not intent or intent["result"] != "draft_only":
                self.note("receipt_without_pending_intent", message=mid)
                return
            outcome = data.get("result", "confirmed")
            if outcome != "confirmed":
                intent["result"] = "simulated_send_unknown" if outcome == "unknown" else "simulated_send_rejected"
                self.handoff(intent["result"])
                return
            event = "S6_or_S6_INTENT_confirmed" if mid in {"S6", "S6_INTENT"} else f"{mid}_confirmed"
            if (self.state, event) not in self.transitions:
                self.note("receipt_ignored_wrong_stage", message=mid)
                return
            intent["result"] = "simulated_send_confirmed"
            self.move(event)
            if mid in {"S6", "S6_INTENT"}:
                self.clarification_count += 1
            if mid == "S3":
                self.test_receipt_id = event_id
        elif kind == "clarification":
            if self.state != "waiting_clarification":
                self.note("clarification_ignored_wrong_stage")
                return
            if data.get("refused"):
                self.move("refused_to_clarify")
                return
            self.facts.update(copy.deepcopy(data.get("facts", {})))
            decision = screen(self.config, self.facts)
            if decision["outcome"] == "missing":
                self.move("incomplete_reply")
            else:
                self.move("complete_reply")
                self.evaluate()
        elif kind == "consent":
            if self.state != "waiting_consent" or data.get("in_reply_to") != "S1":
                self.note("consent_ignored_wrong_context")
                return
            if data.get("answer") == "yes":
                self.move("explicit_agreement")
                self.draft(self.config["workflow"]["test_message"])
            elif data.get("answer") == "no":
                self.move("explicit_refusal")
                self.draft(self.config["workflow"]["refusal_message"])
            else:
                self.handoff("ambiguous_or_temporary_busy")
        elif kind == "clock":
            elapsed = data["hours"]
            if elapsed < 0:
                raise ValueError("Simulation clock cannot move backwards")
            self.hour += elapsed
            key = {"waiting_clarification": "clarification_hours", "waiting_consent": "consent_hours"}.get(self.state)
            if key and self.wait_since is not None and self.hour - self.wait_since >= self.config["workflow"]["timeouts"][key]:
                previous = self.state
                self.state = self.config["workflow"]["timeout_outcomes"][self.state]
                self.wait_since = None
                self.note("timeout", previous_state=previous)
            else:
                self.note("clock_no_deadline_reached")
        elif kind == "claims_email_sent":
            self.note("candidate_claim_only_not_receipt")
        elif kind == "mail_receipt":
            if self.state not in {"waiting_email", "submission_incomplete"}:
                self.note("mail_ignored_wrong_stage")
                return
            if (data.get("candidate_id") != self.candidate_id or data.get("job_id") != self.config["job"]["id"]
                    or data.get("send_event") != self.test_receipt_id or data.get("verified") is not True):
                self.handoff("mail_identity_or_receipt_unverified")
                return
            if set(self.config["questionnaire"]["required_files"]).issubset(set(data.get("files", []))):
                self.move("matched_complete_receipt")
                self.note("simulated_local_review_task_created")
            elif self.state == "waiting_email":
                self.move("matched_partial_receipt")
            else:
                self.note("still_missing_required_files")
        else:
            raise ValueError(f"Unsupported simulation event {kind}")


def record(level="本科", major="软件工程", **extra):
    return {"level": level, "major": major, "stage": "graduated", "evidence": "虚构教育经历", **extra}


def qualifying(**overrides):
    result = {"education_records": [record()], "education_complete": True,
              "planning_intent": {"status": "confirmed", "value": True, "evidence": "我想应聘游戏策划"}}
    result.update(overrides)
    return result


def reach_consent(sim):
    sim.event("screen", "screen")
    sim.check("通过后只生成S1草稿，不启动等待计时", sim.state == "consent_pending" and sim.wait_since is None)
    sim.event("s1-receipt", "receipt", message="S1")
    sim.check("模拟S1回执后才等待意愿", sim.state == "waiting_consent")


def reach_email(sim):
    reach_consent(sim)
    sim.event("consent", "consent", answer="yes", in_reply_to="S1")
    sim.check("同意后只有S3草稿，尚未进入等待邮箱", sim.state == "test_pending" and "S3" in sim.intents)
    sim.event("s3-receipt", "receipt", message="S3")
    sim.check("模拟S3回执后才等待邮箱", sim.state == "waiting_email")


def mail_data(sim, files):
    return {"candidate_id": sim.candidate_id, "job_id": sim.config["job"]["id"],
            "send_event": sim.test_receipt_id, "verified": True, "files": files}


def run_scenarios(config, messages):
    cases = []

    def run(name, fn, facts=None, link=False):
        sim = Simulation(config, messages, facts if facts is not None else qualifying(), simulated_link=link)
        failure = None
        try:
            fn(sim)
            sim.check("真实外部动作均为0", not any(sim.real_actions.values()))
        except Exception as exc:
            failure = f"{type(exc).__name__}: {exc}"
        cases.append({"name": name, "passed": failure is None, "failure": failure, "final_state": sim.state,
                      "simulation": True, "simulated_link_override": link, "assertions": sim.checks,
                      "trace": sim.trace, "drafts": sim.drafts, "real_actions": sim.real_actions})

    def complete(s):
        reach_email(s)
        s.event("mail", "mail_receipt", **mail_data(s, ["questionnaire", "resume"]))
        s.check("模拟材料齐全进入待批改", s.state == "awaiting_review")
    run("合格主线到模拟邮件齐备", complete, link=True)

    def blocked(s):
        reach_consent(s)
        s.event("consent", "consent", answer="yes", in_reply_to="S1")
        s.check("真实配置缺链接阻止S3草稿及发题", s.state == "test_pending" and "S3" not in s.intents)
        s.event("fake", "receipt", message="S3")
        s.check("无S3意图不能伪造进入等待邮箱", s.state == "test_pending")
    run("实际配置缺固定链接保持阻塞", blocked)

    def clarify(s):
        s.event("screen", "screen")
        s.check("只缺意向使用专用补问", s.state == "clarification_pending" and "S6_INTENT" in s.intents)
        s.event("clarify-receipt", "receipt", message="S6_INTENT")
        s.event("reply", "clarification", facts={"planning_intent": qualifying()["planning_intent"]})
        s.check("一次补充后重新筛选通过", s.state == "consent_pending" and s.clarification_count == 1)
    run("缺意向补问后通过", clarify, qualifying(planning_intent={}))

    def incomplete(s):
        s.event("screen", "screen")
        s.event("receipt", "receipt", message="S6")
        s.event("reply", "clarification", facts={"deep_games": "只回答游戏"})
        s.check("补问后仍缺项转人工且不再次补问", s.state == "human_review" and len([d for d in s.drafts if d["message"].startswith("S6")]) == 1)
    run("补问一次后仍缺项", incomplete, {})

    def simple(expected):
        def check(s):
            s.event("screen", "screen")
            s.check("筛选分支符合预期", s.state == expected)
        return check
    run("不能跨教育经历拼接", simple("rejection_pending"), qualifying(education_records=[record("专科", "软件工程"), record("本科", "法学", category="法学", category_confirmed=True)]))
    run("本科非白名单硕士计算机通过", simple("consent_pending"), qualifying(education_records=[record("本科", "法学", category="法学", category_confirmed=True), record("硕士", "计算机科学与技术")]))
    run("本科大四符合", simple("consent_pending"), qualifying(education_records=[record(stage="studying", year=4)]))
    run("本科低年级不自行推定", simple("human_review"), qualifying(education_records=[record(stage="studying", year=2)]))
    run("非白名单边界专业人工", simple("human_review"), qualifying(education_records=[record(major="信息管理与信息系统")]))
    run("专业明确不符形成婉拒草稿", simple("rejection_pending"), qualifying(education_records=[record(major="法学", category="法学", category_confirmed=True)]))
    run("主动咨询不代替意向证据", simple("clarification_pending"), qualifying(planning_intent={"status": "inferred", "value": True, "evidence": "你好"}))
    run("多来源冲突转人工", simple("human_review"), qualifying(conflict=True))

    def clarification_timeout(s):
        s.event("screen", "screen")
        s.event("before", "clock", hours=100)
        s.check("未发补问没有超时", s.state == "clarification_pending")
        s.event("receipt", "receipt", message="S6")
        s.event("early", "clock", hours=47)
        s.check("47小时仍等待", s.state == "waiting_clarification")
        s.event("deadline", "clock", hours=1)
        s.check("48小时未回进入流失", s.state == "lost")
    run("补问48小时从回执计时", clarification_timeout, {})

    def consent_timeout(s):
        reach_consent(s)
        s.event("early", "clock", hours=71)
        s.check("71小时仍等待意愿", s.state == "waiting_consent")
        s.event("deadline", "clock", hours=1)
        s.check("72小时进入流失", s.state == "lost")
    run("意愿72小时超时", consent_timeout)

    def no_timeout(s):
        reach_email(s)
        s.event("long", "clock", hours=10000)
        s.check("发题后不超时也不催办", s.state == "waiting_email" and len(s.drafts) == 2)
    run("发题后无限期等待", no_timeout, link=True)

    def handoff(s):
        s.event("salary", "salary_question")
        s.event("later", "screen")
        s.event("attachment", "attachment", request_id="one")
        s.event("clock", "clock", hours=100)
        s.check("薪资人工接管后不发消息不拒附件不超时", s.state == "human_review" and not s.drafts and not s.attachments and s.hour == 0)
    run("薪资问题转人工并暂停", handoff)

    def attachment(s):
        s.event("attachment", "attachment", request_id="one")
        s.event("duplicate", "attachment", request_id="one")
        s.check("附件只形成一次引导草稿不跳过筛选", s.state == "screening" and len(s.drafts) == 1 and s.drafts[0]["message"] == "S7_BEFORE_TEST")
        s.event("screen", "screen")
        s.check("附件后正常筛选未视为问卷同意", s.state == "consent_pending")
    run("附件引导不越过筛选", attachment)

    def terminal(s):
        s.event("screen", "screen")
        s.event("receipt", "receipt", message="S4")
        s.event("attachment", "attachment", request_id="one")
        s.check("婉拒后只有附件动作草稿无引导消息", s.state == "rejected_screening" and len(s.drafts) == 1)
        s.event("late", "screen")
        s.check("迟到消息转人工不重开", s.state == "human_review")
    run("终态附件与迟到消息", terminal, qualifying(planning_intent={"status": "confirmed", "value": False, "evidence": "不想做策划"}))

    def email_claim(s):
        reach_email(s)
        s.event("claim", "claims_email_sent")
        s.check("聊天已发送不当收件证据", s.state == "waiting_email")
        s.event("partial", "mail_receipt", **mail_data(s, ["questionnaire"]))
        s.check("缺简历为材料不全", s.state == "submission_incomplete")
        s.event("complete", "mail_receipt", **mail_data(s, ["questionnaire", "resume"]))
        s.check("齐全后进入待批改", s.state == "awaiting_review")
    run("自述不算收件及部分材料补齐", email_claim, link=True)

    def unmatched(s):
        reach_email(s)
        data = mail_data(s, ["questionnaire", "resume"])
        data["candidate_id"] = "different-synthetic-candidate"
        s.event("mail", "mail_receipt", **data)
        s.check("邮件身份不符必须人工", s.state == "human_review")
    run("邮件身份关联失败", unmatched, link=True)

    def duplicate(s):
        reach_consent(s)
        s.event("s1-receipt", "receipt", message="S1")
        s.event("other-receipt", "receipt", message="S1")
        s.event("consent", "consent", answer="yes", in_reply_to="S1")
        s.event("consent", "consent", answer="yes", in_reply_to="S1")
        s.event("another-consent", "consent", answer="yes", in_reply_to="S1")
        s.check("重复事件不同ID重复回执均不重复生成话术", len(s.drafts) == 2 and s.state == "test_pending")
    run("入站事件和发送意图去重", duplicate, link=True)

    def send_unknown(s):
        s.event("screen", "screen")
        s.event("unknown", "receipt", message="S1", result="unknown")
        s.event("retry", "receipt", message="S1")
        s.event("screen_again", "screen")
        s.check("未知发送结果不重试不推进", s.state == "human_review" and len(s.drafts) == 1 and s.intents["S1"]["result"] == "simulated_send_unknown")
    run("发送结果未知不重试", send_unknown)

    def wrong_consent(s):
        reach_consent(s)
        s.event("wrong", "consent", answer="yes", in_reply_to="S6")
        s.check("回答其他问题的好的不算同意问卷", s.state == "waiting_consent" and "S3" not in s.intents)
        s.event("busy", "consent", answer="tomorrow", in_reply_to="S1")
        s.check("暂时忙转人工而非拒绝", s.state == "human_review")
    run("同意上下文与暂时没空", wrong_consent)

    def decline(s):
        reach_consent(s)
        s.event("no", "consent", answer="no", in_reply_to="S1")
        s.check("明确拒绝生成收尾草稿", s.state == "decline_pending")
        s.event("done", "receipt", message="DECLINE_TEST")
        s.check("收尾模拟回执后婉拒笔试", s.state == "declined_test")
    run("明确拒绝问卷", decline)

    def stopped(s):
        s.event("stop", "stop_contact")
        s.event("attachment", "attachment", request_id="one")
        s.event("screen", "screen")
        s.check("停止联系后所有动作暂停", s.state == "do_not_contact" and not s.drafts and not s.attachments)
    run("停止联系优先", stopped)
    return cases


def build_report():
    config, messages, validation = load_inputs()
    cases = run_scenarios(config, messages)
    return {"mode": "simulation_only", "generated_at": datetime.now(timezone(timedelta(hours=8))).isoformat(),
            "config_hash": hashlib.sha256(DEFAULT_JOB.read_bytes() + DEFAULT_MESSAGES.read_bytes()).hexdigest(),
            "production_readiness": validation, "real_actions": {"messages_sent": 0, "attachments_rejected": 0, "mailbox_reads": 0},
            "passed": sum(x["passed"] for x in cases), "total": len(cases), "cases": cases,
            "limitations": ["仅结构化虚构资料及模拟事件，不是实际BOSS或邮箱端到端验收。",
                            "回放器不是生产执行引擎：没有自然语言提取、浏览器、持久化队列、实际计时器或发送回执适配。",
                            "模拟主线在内存中使用simulation.invalid链接，未修改实际岗位配置；实际缺链接仍阻塞。",
                            "筛选结果和消息均为离线建议/草稿，没有真实录用、拒绝、发送或附件操作。",
                            "终态、附件以及邮件策略的模拟不表示未确认规则已获批准。"]}


def main():
    report = build_report()
    out = ROOT / ".local/validation"
    out.mkdir(parents=True, exist_ok=True)
    json_path = out / "recruiting-replay-latest.json"
    md_path = out / "recruiting-replay-latest.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# 招聘流程离线模拟回放", "", f"生成时间：{report['generated_at']}", "",
             f"**模拟案例通过 {report['passed']}/{report['total']}；真实发送、附件拒收、邮箱读取均为0。**", "",
             "## 范围", "", *[f"- {x}" for x in report["limitations"]], "", "## 模拟结果", "",
             "| 案例 | 结果 | 结束状态 |", "|---|---|---|"]
    for case in report["cases"]:
        lines.append(f"| {case['name']} | {'通过' if case['passed'] else '失败'} | {case['final_state']} |")
    lines += ["", "## 实际配置执行阻塞", "", *[f"- {x}" for x in report["production_readiness"]["execution_blockers"]]]
    lines += ["", "## 每例断言与模拟轨迹", ""]
    for case in report["cases"]:
        lines += [f"### {case['name']}", "", f"虚构链接覆盖：{case['simulated_link_override']}。最终状态：{case['final_state']}。", ""]
        lines += [f"- {'通过' if x['passed'] else '失败'}：{x['assertion']}" for x in case["assertions"]]
        if case["failure"]:
            lines += [f"- 错误：{case['failure']}"]
        lines += ["", "```json", json.dumps(case["trace"], ensure_ascii=False, indent=2), "```", ""]
    md_path.write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"mode": "simulation_only", "passed": report["passed"], "total": report["total"],
                      "real_actions": report["real_actions"], "production_execution_ready": report["production_readiness"]["execution_ready"],
                      "json": str(json_path), "markdown": str(md_path)}, ensure_ascii=False, indent=2))
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
