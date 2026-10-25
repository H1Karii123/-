# dsh-napcat-common

走 NapCat 的 OneBot HTTP 接口查群、成员、好友关系。**只读**：调 get_* 查询接口，

## 八个工具

| 工具 | 作用 |
|---|---|
| `napcat_groups` | 列当前登录 QQ 的全部群（群号/群名/人数） |
| `napcat_common_members` | 指定一个群 → 成员还在哪些群、共同几个群、重叠群排行 |
| `napcat_group_intersect` | 给 2 个以上群 → 同时在这些群里的人（可 `min_shared` 放宽） |
| `napcat_member` | 给 QQ 号 → 在哪些群、每群名片与身份（群主/管理/成员） |
| `napcat_friends` | 好友列表 + 分组统计，可按关键词过滤，可只看"也在某群里"的好友 |
| `napcat_unidirectional` | 单向好友 |
| `napcat_ignored` | 忽略的加群请求、忽略的群通知 |
| `napcat_group_shut` | 群全员禁言状态 + 正在被禁言的成员与剩余时间 |

> 关于拉黑：OneBot/NapCat 没有开放查询 QQ 黑名单的接口，`napcat_unidirectional`
> 是最接近的；屏蔽成员用 `napcat_group_shut`
> 和 `napcat_ignored`（被忽略的入群申请）覆盖。

## 连的是哪儿

默认 `http://127.0.0.1:3000`（配置在 `<NapCat 配置目录>\onebot11_<QQ号>.json`）。
可用插件配置 `napcatBaseUrl` / `accessToken` 覆盖，或环境变量 `NAPCAT_HTTP` / `NAPCAT_TOKEN`。

## 前置条件 NapCat 必须登录 

## 缓存

群成员列表在进程内缓存 3 分钟
`napcat_groups` 传 `refresh:true` 会清缓存。
