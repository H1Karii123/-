// dsh-napcat-common —— 走 NapCat 的 OneBot HTTP 接口查群/成员/好友关系
// 全部只读：只调 get_* / 查询类接口，不发消息、不改群、不拉人。
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'napcat-common';
export const inject = ['tools'];

const DEFAULT_BASE = 'http://127.0.0.1:3000';
const CACHE_MS = 3 * 60 * 1000; // 群成员列表缓存 3 分钟，避免反复拉几千人
const CONCURRENCY = 3;
const TIMEOUT_MS = 20000;

/** 进程内缓存：{ at, groups, membersByGroup: Map<groupId, Map<userId, member>> } */
let cache = { at: 0, groups: null, membersByGroup: new Map() };

function base(config) {
  return String(config?.napcatBaseUrl || process.env.NAPCAT_HTTP || DEFAULT_BASE).replace(/\/+$/, '');
}

function token(config) {
  return String(config?.accessToken || process.env.NAPCAT_TOKEN || '');
}

async function call(config, action, payload) {
  const url = `${base(config)}/${action}`;
  const headers = { 'content-type': 'application/json' };
  const tk = token(config);
  if (tk) headers.authorization = `Bearer ${tk}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `超时（${TIMEOUT_MS} ms）` : error?.message || String(error);
    throw new Error(`连不上 NapCat（${base(config)}/${action}）：${reason}。确认 NapCat 已启动且 OneBot HTTP 端口开着。`);
  }
  if (!res.ok) throw new Error(`NapCat ${action} 返回 HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`NapCat ${action} 返回的不是 JSON`);
  if (body.status && body.status !== 'ok') {
    throw new Error(`NapCat ${action} 失败：retcode ${body.retcode ?? '?'} ${body.message || body.wording || ''}`.trim());
  }
  return body.data;
}

const pick = (value, keys) => {
  for (const key of keys) {
    const v = value?.[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
};

function labelOf(m) {
  const card = String(pick(m, ['card', 'remark', 'group_card']) || '').trim();
  const nick = String(pick(m, ['nickname', 'nick', 'name']) || '').trim();
  if (card && nick && card !== nick) return `${card}（${nick}）`;
  return card || nick || String(pick(m, ['user_id', 'uin', 'uid']) ?? '?');
}

const idOf = (m) => Number(pick(m, ['user_id', 'uin', 'uid']));

async function loadGroups(config) {
  const list = await call(config, 'get_group_list', {});
  if (!Array.isArray(list)) throw new Error('get_group_list 没返回数组');
  return list
    .map((g) => ({
      group_id: Number(g.group_id),
      group_name: String(g.group_name || g.group_id),
      member_count: Number(g.member_count || 0),
      max_member_count: Number(g.max_member_count || 0),
    }))
    .filter((g) => Number.isFinite(g.group_id))
    .sort((a, b) => a.group_id - b.group_id);
}

async function loadMembers(config, groupId) {
  const list = await call(config, 'get_group_member_list', { group_id: groupId });
  if (!Array.isArray(list)) throw new Error(`群 ${groupId} 的成员列表不是数组`);
  const map = new Map();
  for (const m of list) {
    const id = idOf(m);
    if (!Number.isFinite(id)) continue;
    map.set(id, m);
  }
  return map;
}

/** 并发受控地把所有群的成员拉到 cache 里 */
async function fillCache(config, groups, onProgress) {
  const pending = groups.filter((g) => !cache.membersByGroup.has(g.group_id));
  let cursor = 0;
  const failed = [];

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const group = pending[index];
      if (!group) return;
      try {
        const map = await loadMembers(config, group.group_id);
        cache.membersByGroup.set(group.group_id, map);
      } catch (error) {
        failed.push(`${group.group_id} ${group.group_name}：${error.message}`);
      }
      onProgress?.(groups.length - pending.length + cursor);
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length || 1) }, worker));
  return failed;
}

async function ensureData(config) {
  const fresh = Date.now() - cache.at < CACHE_MS && cache.groups;
  if (fresh) return { groups: cache.groups, failed: [] };
  const groups = await loadGroups(config);
  const failed = await fillCache(config, groups);
  cache.groups = groups;
  cache.at = Date.now();
  return { groups, failed };
}

/** userId -> Set<groupId>，基于当前 cache */
function buildIndex() {
  const inGroups = new Map();
  for (const [groupId, members] of cache.membersByGroup) {
    for (const userId of members.keys()) {
      if (!inGroups.has(userId)) inGroups.set(userId, new Set());
      inGroups.get(userId).add(groupId);
    }
  }
  return inGroups;
}

function text(value) {
  return { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: v }] };
}

function resolveGroup(groups, raw) {
  const q = String(raw ?? '').trim();
  if (!q) return null;
  const exact = groups.find((g) => String(g.group_id) === q);
  if (exact) return { group: exact };
  const byName = groups.filter((g) => g.group_name.includes(q));
  if (byName.length === 1) return { group: byName[0] };
  if (byName.length > 1) {
    return {
      candidates: byName,
      hint:
        `「${q}」匹配到 ${byName.length} 个群，请用群号指定：\n` +
        byName.map((g) => `· ${g.group_id}  ${g.group_name}（${g.member_count} 人）`).join('\n'),
    };
  }
  return { missing: q };
}

/** 把一个解析结果统一成 {ok} | {text} */
function resolveOrExplain(groups, raw) {
  const found = resolveGroup(groups, raw);
  if (!found) return { text: '请给一个群号或群名。' };
  if (found.missing) return { text: `没找到群「${found.missing}」。先用 napcat_groups 看现有群号。` };
  if (found.candidates) return { text: found.hint };
  return { group: found.group };
}

export function apply(ctx, config) {
  // ---------- 1) 列群 ----------
  ctx.tools.register(defineTool({
    name: 'napcat_groups',
    description:
      '列出 NapCat（当前登录 QQ）所在的全部群：群号、群名、人数。查“这个人在哪些群里”“共同群友”之前先用它拿到群号。只读。',
    parameters: {
      refresh: { type: 'boolean', description: 'true = 忽略 3 分钟缓存，重新拉一次' },
    },
    output: text(),
    async execute(args) {
      if (args?.refresh) cache = { at: 0, groups: null, membersByGroup: new Map() };
      let groups;
      try {
        groups = await loadGroups(config);
      } catch (error) {
        return error.message;
      }
      cache.groups = groups;
      const total = groups.reduce((sum, g) => sum + g.member_count, 0);
      const lines = groups.map((g) => `· ${g.group_id}  ${g.group_name}（${g.member_count} 人）`);
      return [`共 ${groups.length} 个群，人数合计 ${total}。`, ...lines].join('\n');
    },
  }));

  // ---------- 2) 指定群的共同群友 ----------
  ctx.tools.register(defineTool({
    name: 'napcat_common_members',
    description:
      '指定一个群，去全部群里找“和这个群共同的群友”：列出该群每个成员还出现在哪些群、共同几个群。只读。',
    parameters: {
      group: { type: 'string', description: '群号（推荐），或群名的一部分' },
      limit: { type: 'integer', description: '最多列出多少名共同群友，1–200，默认 40' },
      min_shared: { type: 'integer', description: '至少共同几个群才算，默认 2（即含目标群在内）' },
      summary_only: { type: 'boolean', description: 'true = 只要统计（重叠群排行、人数），不列人名' },
    },
    output: text(),
    async execute(args) {
      const minShared = Math.max(1, Math.min(Number(args?.min_shared ?? 2) || 2, 1000));
      const limit = Math.max(1, Math.min(Number(args?.limit ?? 40) || 40, 200));

      let groups;
      try {
        groups = await ensureData(config);
        groups = groups.groups;
      } catch (error) {
        return error.message;
      }

      const found = resolveOrExplain(groups, args?.group);
      if (found.text) return found.text;
      const target = found.group;
      const targetMembers = cache.membersByGroup.get(target.group_id);
      if (!targetMembers) return `群 ${target.group_id} 的成员列表没拉到（可能权限或超时），稍后重试。`;

      const inGroups = buildIndex();
      const nameOf = new Map(groups.map((g) => [g.group_id, g.group_name]));
      const rows = [];
      for (const [userId, member] of targetMembers) {
        const set = inGroups.get(userId);
        if (!set || set.size < minShared) continue;
        const others = [...set].filter((id) => id !== target.group_id);
        rows.push({ userId, member, count: set.size, others });
      }
      rows.sort((a, b) => b.count - a.count || a.userId - b.userId);

      const overlap = new Map();
      for (const row of rows) for (const id of row.others) overlap.set(id, (overlap.get(id) || 0) + 1);
      const overlapRank = [...overlap.entries()].sort((a, b) => b[1] - a[1]);

      const head = [
        `目标群：${target.group_id} ${target.group_name}（${targetMembers.size} 人）`,
        `扫了 ${cache.membersByGroup.size} 个群的成员列表；共同群友 ${rows.length} 人（至少共同 ${minShared} 个群）。`,
      ];
      if (overlapRank.length) {
        head.push(
          '重叠群排行：' +
            overlapRank
              .slice(0, 8)
              .map(([id, n]) => `${nameOf.get(id) || id} ${n} 人`)
              .join('；'),
        );
      }
      if (args?.summary_only) return head.join('\n');

      const lines = rows.slice(0, limit).map((row) => {
        const shared = row.others.map((id) => nameOf.get(id) || id).join('、');
        return `· ${labelOf(row.member)}（${row.userId}）共同 ${row.count} 群：${shared}`;
      });
      const footer = rows.length > limit ? [`…… 还有 ${rows.length - limit} 人，调大 limit 或看 summary_only。`] : [];
      return [...head, '', ...lines, ...footer].join('\n');
    },
  }));

  // ---------- 3) 多个群的共同成员（交集） ----------
  ctx.tools.register(defineTool({
    name: 'napcat_group_intersect',
    description:
      '给两个或更多群，列出同时在这些群里的人（默认要求出现在全部群里，可用 min_shared 放宽到“至少出现在 N 个”）。只读。',
    parameters: {
      groups: { type: 'array', items: { type: 'string' }, description: '群号或群名片段，2 个以上' },
      min_shared: { type: 'integer', description: '至少同时出现在几个群里，默认 = 全部' },
      limit: { type: 'integer', description: '最多列出多少人，1–300，默认 60' },
    },
    output: text(),
    async execute(args) {
      const raw = Array.isArray(args?.groups) ? args.groups : [args?.groups].filter(Boolean);
      if (raw.length < 2) return '至少给两个群。';
      const limit = Math.max(1, Math.min(Number(args?.limit ?? 60) || 60, 300));

      let groups;
      try {
        groups = (await ensureData(config)).groups;
      } catch (error) {
        return error.message;
      }

      const targets = [];
      for (const item of raw) {
        const found = resolveOrExplain(groups, item);
        if (found.text) return found.text;
        if (!targets.some((t) => t.group_id === found.group.group_id)) targets.push(found.group);
      }
      const missingMembers = targets.filter((t) => !cache.membersByGroup.has(t.group_id));
      if (missingMembers.length) {
        return `这些群的成员列表没拉到：${missingMembers.map((g) => g.group_id).join('、')}，稍后重试。`;
      }

      const need = Math.max(2, Math.min(Number(args?.min_shared ?? targets.length) || targets.length, targets.length));
      const counts = new Map(); // userId -> { hit: Set<groupId>, member }
      for (const t of targets) {
        for (const [userId, member] of cache.membersByGroup.get(t.group_id)) {
          if (!counts.has(userId)) counts.set(userId, { hit: new Set(), member });
          counts.get(userId).hit.add(t.group_id);
        }
      }

      const nameOf = new Map(groups.map((g) => [g.group_id, g.group_name]));
      const rows = [...counts.entries()]
        .filter(([, v]) => v.hit.size >= need)
        .map(([userId, v]) => ({ userId, member: v.member, hit: [...v.hit], n: v.hit.size }))
        .sort((a, b) => b.n - a.n || a.userId - b.userId);

      const head = [
        '查询的群：' + targets.map((t) => `${t.group_id} ${t.group_name}（${t.member_count} 人）`).join(' / '),
        `同时出现在其中 ${need} 个及以上群的人：${rows.length} 人。`,
      ];
      if (!rows.length) return head.join('\n');
      const lines = rows.slice(0, limit).map((r) => {
        const where = r.hit.map((id) => nameOf.get(id) || id).join('、');
        return `· ${labelOf(r.member)}（${r.userId}）${r.n} 个群：${where}`;
      });
      const footer = rows.length > limit ? [`…… 还有 ${rows.length - limit} 人。`] : [];
      return [...head, '', ...lines, ...footer].join('\n');
    },
  }));

  // ---------- 4) 单个成员在哪些群 ----------
  ctx.tools.register(defineTool({
    name: 'napcat_member',
    description: '查一个 QQ 用户在哪些群里：给 QQ 号，返回所在全部群、每群名片/身份、共同群数。只读。',
    parameters: {
      user: { type: 'string', description: 'QQ 号' },
    },
    output: text(),
    async execute(args) {
      const userId = Number(String(args?.user ?? '').trim());
      if (!Number.isFinite(userId) || userId <= 0) return '请给一个 QQ 号（纯数字）。';

      let groups;
      try {
        groups = (await ensureData(config)).groups;
      } catch (error) {
        return error.message;
      }

      const nameOf = new Map(groups.map((g) => [g.group_id, g.group_name]));
      const hits = [];
      let sample = null;
      for (const [groupId, members] of cache.membersByGroup) {
        const m = members.get(userId);
        if (m) {
          hits.push({ groupId, m });
          sample ??= m;
        }
      }
      if (!hits.length) {
        return `在扫过的 ${cache.membersByGroup.size} 个群里没找到 ${userId}。可能不在这些群，或群太多还没扫全。`;
      }
      const head = [
        `用户：${labelOf(sample)}（${userId}）`,
        `在 ${hits.length} / ${cache.membersByGroup.size} 个群里。`,
      ];
      const lines = hits.map(({ groupId, m }) => {
        const role = String(pick(m, ['role']) || 'member');
        const roleText = role === 'owner' ? '群主' : role === 'admin' ? '管理' : '成员';
        return `· ${groupId} ${nameOf.get(groupId) || ''}　${labelOf(m)}　${roleText}`;
      });
      return [...head, '', ...lines].join('\n');
    },
  }));

  // ---------- 5) 好友列表 ----------
  ctx.tools.register(defineTool({
    name: 'napcat_friends',
    description:
      '列出 NapCat 当前 QQ 的好友（可按关键词过滤、看分组统计），还能顺便标出“哪些好友在你某个群里”。只读。',
    parameters: {
      search: { type: 'string', description: '可选：昵称/备注/QQ 号片段' },
      group: { type: 'string', description: '可选：只列也在这个群里的人（群号或群名片段）' },
      limit: { type: 'integer', description: '最多列多少，1–300，默认 60' },
    },
    output: text(),
    async execute(args) {
      const limit = Math.max(1, Math.min(Number(args?.limit ?? 60) || 60, 300));
      const q = String(args?.search ?? '').trim().toLowerCase();

      let friends;
      let categories = [];
      try {
        friends = await call(config, 'get_friend_list', {});
        categories = await call(config, 'get_friends_with_category', {}).catch(() => []);
      } catch (error) {
        return error.message;
      }
      if (!Array.isArray(friends)) return 'get_friend_list 没返回数组。';

      let rows = friends
        .map((f) => ({ userId: idOf(f), raw: f, label: labelOf(f), remark: String(pick(f, ['remark']) || '') }))
        .filter((f) => Number.isFinite(f.userId));

      if (q) {
        rows = rows.filter(
          (f) => f.label.toLowerCase().includes(q) || String(f.userId).includes(q),
        );
      }

      let groupNote = '';
      if (args?.group) {
        let groups;
        try {
          groups = await ensureData(config);
          groups = groups.groups;
        } catch (error) {
          return error.message;
        }
        const found = resolveOrExplain(groups, args.group);
        if (found.text) return found.text;
        const members = cache.membersByGroup.get(found.group.group_id) || new Map();
        rows = rows.filter((f) => members.has(f.userId));
        groupNote = `（只列也在 ${found.group.group_id} ${found.group.group_name} 里的人）`;
      }

      const cats = Array.isArray(categories) ? categories.map((c) => ({
        name: String(pick(c, ['categoryName', 'category_name']) || '未命名'),
        count: Array.isArray(c?.buddyList) ? c.buddyList.length : 0,
      })) : [];

      const head = [`好友共 ${friends.length} 人${q ? `，匹配「${args.search}」${rows.length} 人` : ''}${groupNote}。`];
      if (cats.length) head.push('分组：' + cats.map((c) => `${c.name} ${c.count}`).join('；'));

      const lines = rows.slice(0, limit).map((f) => {
        const remark = f.remark && f.remark !== f.label ? `　备注：${f.remark}` : '';
        return `· ${f.label}（${f.userId}）${remark}`;
      });
      const footer = rows.length > limit ? [`…… 还有 ${rows.length - limit} 人，调大 limit。`] : [];
      return [...head, ...(lines.length ? ['', ...lines] : ['', '（没有匹配的人）']), ...footer].join('\n');
    },
  }));

  // ---------- 6) 单向好友（对方删了/拉黑了你） ----------
  ctx.tools.register(defineTool({
    name: 'napcat_unidirectional',
    description:
      '列出“单向好友”：你这边还是好友、但对方已经把你删了或拉黑的人。NapCat/OneBot 没有直接的“黑名单”接口，这个是最接近的。只读。',
    parameters: {
      limit: { type: 'integer', description: '最多列多少，1–300，默认 80' },
    },
    output: text(),
    async execute(args) {
      const limit = Math.max(1, Math.min(Number(args?.limit ?? 80) || 80, 300));
      let list;
      try {
        list = await call(config, 'get_unidirectional_friend_list', {});
      } catch (error) {
        return `${error.message}\n（如果 NapCat 版本不支持 get_unidirectional_friend_list，这条路暂时用不了。）`;
      }
      if (!Array.isArray(list)) return 'get_unidirectional_friend_list 没返回数组。';
      if (!list.length) return '没有单向好友：好友列表里没有“对方已删除你”的人。';
      const lines = list.slice(0, limit).map((f) => `· ${labelOf(f)}（${idOf(f)}）`);
      const footer = list.length > limit ? [`…… 还有 ${list.length - limit} 人。`] : [];
      return [`单向好友 ${list.length} 人。`, '', ...lines, ...footer].join('\n');
    },
  }));

  // ---------- 7) 群忽略（被屏蔽的入群请求 / 群内忽略通知） ----------
  ctx.tools.register(defineTool({
    name: 'napcat_ignored',
    description:
      '查被忽略（屏蔽）的东西：某个群的“忽略加群请求”列表，以及群系统里被忽略的通知。给群号可只看该群。只读。',
    parameters: {
      group: { type: 'string', description: '可选：群号或群名片段；不传则看全局' },
      limit: { type: 'integer', description: '最多列多少，1–200，默认 50' },
    },
    output: text(),
    async execute(args) {
      const limit = Math.max(1, Math.min(Number(args?.limit ?? 50) || 50, 200));
      const out = [];

      let groupId = null;
      if (args?.group) {
        let groups;
        try {
          groups = (await loadGroups(config));
        } catch (error) {
          return error.message;
        }
        const found = resolveOrExplain(groups, args.group);
        if (found.text) return found.text;
        groupId = found.group.group_id;
        out.push(`只看群：${groupId} ${found.group.group_name}`);
      }

      const ignoredAdd = await call(config, 'get_group_ignore_add_request', {}).catch((e) => e);
      if (ignoredAdd instanceof Error) {
        out.push(`忽略加群请求：取不到（${ignoredAdd.message}）`);
      } else {
        const list = Array.isArray(ignoredAdd) ? ignoredAdd : ignoredAdd?.list || [];
        const filtered = groupId ? list.filter((x) => Number(pick(x, ['group_id'])) === groupId) : list;
        out.push(`忽略的加群请求：${filtered.length} 条`);
        for (const item of filtered.slice(0, limit)) {
          const who = labelOf(item?.invitor || item?.user || item) || '?';
          const g = pick(item, ['group_id', 'group_code']) ?? '?';
          const why = String(pick(item, ['message', 'comment', 'flag']) || '').slice(0, 40);
          out.push(`· 群 ${g}　${who}${why ? `　${why}` : ''}`);
        }
      }

      const notifies = await call(config, 'get_group_ignored_notifies', {}).catch((e) => e);
      if (notifies instanceof Error) {
        out.push(`忽略的群通知：取不到（${notifies.message}）`);
      } else {
        const list = Array.isArray(notifies) ? notifies : notifies?.list || [];
        const filtered = groupId ? list.filter((x) => Number(pick(x, ['group_id'])) === groupId) : list;
        out.push(`忽略的群通知：${filtered.length} 条`);
        for (const item of filtered.slice(0, limit)) {
          const g = pick(item, ['group_id']) ?? '?';
          const t = String(pick(item, ['message', 'content', 'message_seq']) || '').slice(0, 60);
          out.push(`· 群 ${g}　${t}`);
        }
      }
      return out.join('\n');
    },
  }));

  // ---------- 8) 群禁言情况 ----------
  ctx.tools.register(defineTool({
    name: 'napcat_group_shut',
    description: '查一个群的禁言情况：是否全员禁言、哪些成员正在被禁言（含剩余时间）。对应 NapCat 的 get_group_info + get_group_shut_list。只读。',
    parameters: {
      group: { type: 'string', description: '群号或群名片段' },
      limit: { type: 'integer', description: '最多列多少被禁言成员，1–200，默认 50' },
    },
    output: text(),
    async execute(args) {
      const limit = Math.max(1, Math.min(Number(args?.limit ?? 50) || 50, 200));
      let groups;
      try {
        groups = await loadGroups(config);
      } catch (error) {
        return error.message;
      }
      const found = resolveOrExplain(groups, args?.group);
      if (found.text) return found.text;
      const g = found.group;

      const out = [`群：${g.group_id} ${g.group_name}（${g.member_count} 人）`];
      const info = await call(config, 'get_group_info', { group_id: g.group_id }).catch((e) => e);
      if (info instanceof Error) {
        out.push(`群信息取不到：${info.message}`);
      } else {
        const whole = pick(info, ['whole_ban', 'group_whole_ban', 'shutup_all']);
        out.push(`全员禁言：${whole === true || whole === 1 ? '是' : '否'}`);
      }

      const list = await call(config, 'get_group_shut_list', { group_id: g.group_id }).catch((e) => e);
      if (list instanceof Error) {
        out.push(`禁言列表取不到：${list.message}`);
        return out.join('\n');
      }
      const arr = Array.isArray(list) ? list : list?.list || [];
      if (!arr.length) {
        out.push('当前没有被禁言的成员。');
        return out.join('\n');
      }
      const now = Math.floor(Date.now() / 1000);
      out.push(`被禁言成员：${arr.length} 人`);
      for (const m of arr.slice(0, limit)) {
        const until = Number(pick(m, ['shut_up_time', 'shutup_time', 'ban_expire_time', 'expire_time']) || 0);
        const nick = labelOf(m);
        const uid = idOf(m);
        let when = '';
        if (until > now) {
          const mins = Math.round((until - now) / 60);
          when = `　剩余约 ${mins} 分钟`;
        } else if (until > 0) {
          when = `　已到期（${new Date(until * 1000).toLocaleString('zh-CN', { hour12: false })}）`;
        }
        out.push(`· ${nick}（${Number.isFinite(uid) ? uid : '?'}）${when}`);
      }
      if (arr.length > limit) out.push(`…… 还有 ${arr.length - limit} 人。`);
      return out.join('\n');
    },
  }));
}
