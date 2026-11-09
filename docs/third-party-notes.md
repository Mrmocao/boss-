# 第三方参考记录

本文件记录外部项目的核验范围和未来复用边界。它不是运行时依赖清单，也不表示项目已经复制或集成了这些代码。

| 项目 | URL | 核验版本/分支 | 许可证状态 | 当前使用方式 |
|---|---|---|---|---|
| GoodHR 5 | https://github.com/hhh0078/goodhr | `04ae1884fa46d8fb5ddaf96ea34f070638094cdc` | Apache-2.0 | 架构、平台适配器、岗位运行、日志和本地数据边界参考 |
| GoodHR Assistant OSS | https://github.com/Linchawla/goodhr-oss-public | `178607fe01a55a7d9bda51b235a05f5597cd06d0` | Apache-2.0 | Manifest V3、站点 parser、关键词筛选和本地设置参考 |
| Recruitment Assistant | https://github.com/wujysh/recruiting-assistant | `master` README | 未发现许可证声明 | 只参考公司、用户、角色、标签领域概念 |
| RecruitFlowAI | https://github.com/COXIT-CO/RecruitFlowAI | `dev` README | MIT（以仓库当前声明为准） | 参考招聘命令和工作流结果组织 |
| InterviewGuide | https://github.com/Snailclimb/interview-guide | `master` README | AGPL-3.0 | 只参考异步解析、RAG、题库、评估的数据契约 |
| Prepwise / AI Mock Interviews | https://github.com/adrianhajdin/ai_mock_interviews | `96d01db148b0c80e44ffddf138ce5d04a8eb2455` | 未声明 | 只参考语音面试的交互流程 |

## 采用规则

1. 外部代码进入本仓库前必须记录来源文件、原始 commit、许可证、改动说明和测试结果。
2. Apache-2.0、MIT 等许可证仍需保留版权和许可证文本，并检查依赖的传递许可证。
3. 未声明许可证的仓库只做概念研究，不能复制代码、图片、提示词、数据库结构或品牌素材。
4. AGPL 项目只允许做协议、数据模型和流程层面的参考；是否采用代码必须单独评估分发方式和许可证义务。
5. 不导入候选人样例、Cookie、截图、平台账号、真实聊天记录或第三方服务密钥。
6. 每季度或平台发生页面变化时复查参考项目的许可证、分支和技术假设，避免根据过时 README 设计生产行为。
