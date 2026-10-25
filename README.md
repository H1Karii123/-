# dsh-napcat-common

走 NapCat 的 OneBot HTTP 接口查群、成员、好友关系。**全部只读**：只调 get_* 查询接口，

## 八个工具

| 工具 | 作用 |
|---|---|
| `napcat_groups` | 列当前登录 QQ 的全部群（群号/群名/人数） |
| `napcat_common_members` | 指定一个群 → 成员还在哪些群、共同几个群、重叠群排行 |
| `napcat_group_intersect` | 给 2 个以上群 → 同时在这些群里的人（可 `min_shared` 放宽） |
| `napcat_member` | 给 QQ 号 → 在哪些群、每群名片与身份（群主/管理/成员） |
| `napcat_friends` | 好友列表 + 分组统计，可按关键词过滤，可只看"也在某群里"的好友 |
| `napcat_unidirectional` | 单向好友（你这边还是好友、对方已删/拉黑你） |
| `napcat_ignored` | 忽略的加群请求、忽略的群通知（= 被屏蔽的入群申请） |
| `napcat_group_shut` | 群全员禁言状态 + 正在被禁言的成员与剩余时间 |

> 关于拉黑：OneBot/NapCat 没有开放查询 QQ 黑名单的接口，`napcat_unidirectional`
> 是最接近的；屏蔽成员用 `napcat_group_shut`
> 和 `napcat_ignored`覆盖。

## 连的是哪儿

默认 `http://127.0.0.1:3000`（配置在 `<NapCat 配置目录>\onebot11_<QQ号>.json`）。
可用插件配置 `napcatBaseUrl` / `accessToken` 覆盖，或环境变量 `NAPCAT_HTTP` / `NAPCAT_TOKEN`。

## 前置条件    

NapCat 必须真正登录上。普通 QQ 已经登录同一个号时，NapCat 会报
「当前账号已登录，无法重复登录」。

顺序：
1. 托盘退出 QQ
2. 双击 `启动 NapCat 的脚本`
3. 等日志出现 WebUI 地址
4. 回到 DSH 调用工具

## 缓存

群成员列表在进程内缓存 3 分钟    （几千人的群拉一次要几秒，全量扫会更久）。
`napcat_groups` 传 `refresh:true` 会清缓存。
