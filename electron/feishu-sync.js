"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeishuSyncError = void 0;
exports.cellText = cellText;
exports.mapRecordsToCompanyGroups = mapRecordsToCompanyGroups;
exports.replaceCompanyGroups = replaceCompanyGroups;
exports.localNonCompanyHotkeys = localNonCompanyHotkeys;
exports.fetchTenantToken = fetchTenantToken;
exports.fetchAllRecords = fetchAllRecords;
exports.validateConfig = validateConfig;
exports.syncCompanyFromFeishu = syncCompanyFromFeishu;
const node_crypto_1 = require("node:crypto");
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function mapScopeLabel(label) {
    const value = String(label || '').trim().toLowerCase();
    if (['', '公司话术', '公司', 'company'].includes(value)) return 'company';
    if (['私人话术', '私人', '个人', 'private'].includes(value)) return 'private';
    return 'skip';
}
exports.mapScopeLabel = mapScopeLabel;
const LIBRARY_PRESETS = {
    domestic: { baseToken: 'E6cZbMS57aJWyis3SV3c7cFInKh', tableId: 'tblBEtFX7gsg8CKX' },
    overseas: { baseToken: 'Bjesbt2qsa7lMqsN9a4cAhYZnHc', tableId: 'tblZuZMdLWMClcJW' },
};
function resolveRegion(region, settings = {}) {
    return ['domestic', 'overseas'].includes(region) ? region : settings.feishuLibraryRegion === 'overseas' ? 'overseas' : 'domestic';
}
exports.resolveRegion = resolveRegion;
function resolveConfig(settings = {}, env = process.env, region, envPath = path.join(os.homedir(), '.config', 'ai-kefu-panel', 'feishu.env')) {
    const fileEnv = {};
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
            if (match) fileEnv[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
        }
    }
    const read = (key, setting, fallback = '') => env['HUIYOU_FEISHU_' + key] ?? env['AIKEFU_FEISHU_' + key] ?? fileEnv['HUIYOU_FEISHU_' + key] ?? fileEnv['AIKEFU_FEISHU_' + key] ?? settings[setting] ?? fallback;
    region = resolveRegion(region, settings);
    const prefix = region.toUpperCase() + '_';
    const settingPrefix = region === 'overseas' ? 'feishuOverseas' : 'feishuDomestic';
    // 通用旧 Base/Table 不跨区域复用，避免海外选择误读国内主库。
    return { region, appId: read('APP_ID', 'feishuAppId'), appSecret: read('APP_SECRET', 'feishuAppSecret'), baseToken: read(prefix + 'BASE_TOKEN', settingPrefix + 'BaseToken', LIBRARY_PRESETS[region].baseToken), tableId: read(prefix + 'TABLE_ID', settingPrefix + 'TableId', LIBRARY_PRESETS[region].tableId) };
}
exports.resolveConfig = resolveConfig;
/** 飞书多维表格：公司话术主库同步（拉数 + 映射）。不依赖飞书 SDK，只用全局 fetch。 */
const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const PAGE_SIZE = 500;
const MAX_PAGES = 200;
const REQUEST_TIMEOUT_MS = 20000;
class FeishuSyncError extends Error {
}
exports.FeishuSyncError = FeishuSyncError;
/** 尽量从飞书 cell 值里抽出纯文本：字符串、数字、富文本段数组、{text}/{name}/{value}/{link} 对象等。 */
function cellText(v) {
    if (v == null)
        return '';
    if (typeof v === 'string')
        return v;
    if (typeof v === 'number' || typeof v === 'boolean')
        return String(v);
    if (Array.isArray(v))
        return v.map(cellText).join('');
    if (typeof v === 'object') {
        const o = v;
        for (const k of ['text', 'name', 'value', 'link', 'full_name', 'en_name']) {
            if (o[k] != null)
                return cellText(o[k]);
        }
    }
    return '';
}
function shortHash(s) {
    return (0, node_crypto_1.createHash)('sha1').update(s).digest('hex').slice(0, 12);
}
/**
 * 把飞书行映射成 company groups。
 * - 只收归属映射为 company 的行；空内容跳过
 * - id 稳定：phrase=`feishu:<record_id>`，group/section 按名称哈希
 * - reservedHotkeys：本地保留分组及全局热键已占用的组合，飞书侧冲突的会被清空
 */
function mapRecordsToCompanyGroups(records, reservedHotkeys = []) {
    const groups = new Map();
    const usedHotkeys = new Set([...reservedHotkeys].map((h) => h.trim().toLowerCase()).filter(Boolean));
    const hotkeyCleared = [];
    let skipped = 0;
    let phrasesSynced = 0;
    for (const rec of records) {
        const f = rec.fields || {};
        const get = (name) => cellText(f[name]);
        if (mapScopeLabel(get('归属')) !== 'company') {
            skipped += 1;
            continue;
        }
        const content = get('内容');
        if (!content.trim()) {
            skipped += 1;
            continue;
        }
        const groupName = get('分组').trim() || '未命名分组';
        const sectionName = get('二级分类').trim();
        const title = get('标题').trim() || content.trim().slice(0, 20);
        const titleColor = get('标题颜色').trim() || undefined;
        let hotkey = get('热键').trim() || undefined;
        let group = groups.get(groupName);
        if (!group) {
            group = {
                id: `feishu-group:${shortHash(groupName)}`,
                name: groupName,
                scope: 'company',
                sections: [],
                phrases: [],
            };
            groups.set(groupName, group);
        }
        let sectionId = null;
        if (sectionName) {
            let sec = group.sections.find((s) => s.name === sectionName);
            if (!sec) {
                sec = { id: `feishu-sec:${shortHash(groupName + '\u0000' + sectionName)}`, name: sectionName };
                group.sections.push(sec);
            }
            sectionId = sec.id;
        }
        if (hotkey) {
            const k = hotkey.toLowerCase();
            if (usedHotkeys.has(k)) {
                hotkeyCleared.push(`${title}（${hotkey}）`);
                hotkey = undefined;
            }
            else
                usedHotkeys.add(k);
        }
        const phrase = {
            id: rec.record_id ? `feishu:${rec.record_id}` : `feishu-h:${shortHash(title + '\u0000' + content)}`,
            title,
            content,
            titleColor,
            hotkey,
            section: sectionId,
            images: [],
            files: [],
        };
        group.phrases.push(phrase);
        phrasesSynced += 1;
    }
    return { groups: [...groups.values()], phrasesSynced, skipped, hotkeyCleared };
}
/** 用新的 company groups 替换本地全部 company 分组；personal / squad / stickers 原样保留。 */
function replaceCompanyGroups(library, companyGroups) {
    const firstIdx = library.groups.findIndex((g) => g.scope !== 'private');
    const kept = library.groups.filter((g) => g.scope === 'private');
    const groupsReplaced = library.groups.length - kept.length;
    // 公司分组放回原先第一个公司分组的位置；之前没有则放最前
    const insertAt = firstIdx < 0 ? 0 : library.groups.slice(0, firstIdx).filter((g) => g.scope === 'private').length;
    const groups = [...kept.slice(0, insertAt), ...companyGroups, ...kept.slice(insertAt)];
    return { library: { ...library, groups }, groupsReplaced };
}
/** 本地非 company 分组里已占用的话术热键 */
function localNonCompanyHotkeys(library) {
    const out = [];
    for (const g of library.groups) {
        if (g.scope !== 'private')
            continue;
        for (const p of g.phrases)
            if (p.hotkey?.trim())
                out.push(p.hotkey.trim());
    }
    return out;
}
function describeFeishuError(code, msg, stage) {
    const known = {
        10003: 'App ID 或 App Secret 无效',
        10014: 'App Secret 错误',
        99991663: 'tenant_access_token 无效',
        99991661: '缺少访问凭证',
        99991672: '应用未开通多维表格读取权限（bitable:app:readonly），请在开放平台开通并发布版本',
        99991679: '应用未获授权访问该资源',
        91402: '多维表格不存在，请检查 Base token / Table ID',
        91403: '无权访问该多维表格：请把应用添加为该 Base 的协作者（可阅读）',
        1254003: 'Base token 格式错误',
        1254004: 'Table ID 格式错误',
        1254040: 'Base 不存在，请检查 Base token（注意不是 wiki 节点 token）',
        1254041: '数据表不存在，请检查 Table ID',
        1254302: '无权访问该多维表格：请把应用添加为该 Base 的协作者（可阅读）',
    };
    const hint = known[code] || (stage === 'auth' ? '获取飞书访问凭证失败' : '读取多维表格失败');
    return `${hint}（code ${code}${msg ? `：${msg}` : ''}）`;
}
async function requestJson(fetchImpl, url, init, stage) {
    let res;
    try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    }
    catch (e) {
        const name = e?.name;
        if (name === 'TimeoutError' || name === 'AbortError')
            throw new FeishuSyncError('连接飞书超时，请检查网络');
        throw new FeishuSyncError('无法连接飞书开放平台，请检查网络');
    }
    let body = null;
    try {
        body = (await res.json());
    }
    catch {
        /* 非 JSON */
    }
    if (res.status === 403) throw new FeishuSyncError('飞书返回 403：请开通读取权限并把应用添加为 Base 协作者');
    if (body && typeof body.code === 'number' && body.code !== 0) {
        throw new FeishuSyncError(describeFeishuError(body.code, '', stage));
    }
    if (!res.ok) {
        if (res.status === 403)
            throw new FeishuSyncError('飞书返回 403：应用无权访问该多维表格，请开通权限并把应用加为 Base 协作者');
        if (res.status === 404)
            throw new FeishuSyncError('飞书返回 404：多维表格或数据表不存在，请检查 Base token / Table ID');
        throw new FeishuSyncError(`飞书请求失败（HTTP ${res.status}）`);
    }
    if (!body)
        throw new FeishuSyncError('飞书返回内容无法解析');
    return body;
}
async function fetchTenantToken(cfg, fetchImpl = fetch) {
    const body = await requestJson(fetchImpl, `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    }, 'auth');
    const token = body.tenant_access_token;
    if (!token)
        throw new FeishuSyncError('飞书未返回 tenant_access_token');
    return String(token);
}
async function fetchAllRecords(cfg, token, fetchImpl = fetch) {
    const out = [];
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page++) {
        const qs = new URLSearchParams({ page_size: String(PAGE_SIZE) });
        if (pageToken)
            qs.set('page_token', pageToken);
        if (cfg.viewId)
            qs.set('view_id', cfg.viewId);
        const url = `${FEISHU_BASE}/bitable/v1/apps/${encodeURIComponent(cfg.baseToken)}/tables/${encodeURIComponent(cfg.tableId)}/records?${qs}`;
        const body = await requestJson(fetchImpl, url, { headers: { Authorization: `Bearer ${token}` } }, 'records');
        const data = body.data || {};
        for (const it of (data.items || [])) {
            if (it && typeof it === 'object')
                out.push({ record_id: String(it.record_id || ''), fields: it.fields || {} });
        }
        if (!data.has_more) return out;
        if (!data.page_token || data.page_token === pageToken) throw new FeishuSyncError('飞书分页游标异常，本地未改动');
        pageToken = String(data.page_token);
    }
    throw new FeishuSyncError(`记录超过 ${PAGE_SIZE * MAX_PAGES} 条，已中止`);
}
function emptyResult(message, error) {
    return { ok: false, message, groupsReplaced: 0, phrasesSynced: 0, skipped: 0, hotkeyCleared: [], error };
}
function validateConfig(cfg) {
    if (!cfg.appId || !cfg.appSecret) {
        return '未配置飞书 App ID / App Secret：请在「导入 / 备份」页填写，或设置环境变量 HUIYOU_FEISHU_APP_ID / HUIYOU_FEISHU_APP_SECRET';
    }
    if (!cfg.baseToken || !cfg.tableId)
        return '未配置飞书 Base token / Table ID';
    return null;
}
/**
 * 拉飞书全表 → 生成替换后的 library。不落盘；由调用方备份 + 保存。
 * 失败返回 ok=false 和可读中文错误，library 为 null。
 */
async function syncCompanyFromFeishu(opts) {
    const region = resolveRegion(opts.region || opts.config?.region);
    const regionLabel = region === 'overseas' ? '海外' : '国内';
    const invalid = validateConfig(opts.config);
    if (invalid)
        return { result: emptyResult(invalid, invalid), library: null };
    const fetchImpl = opts.fetchImpl || fetch;
    let records;
    try {
        const token = await fetchTenantToken(opts.config, fetchImpl);
        records = await fetchAllRecords(opts.config, token, fetchImpl);
    }
    catch (e) {
        const msg = e instanceof FeishuSyncError ? e.message : `同步失败：${e?.message || e}`;
        return { result: emptyResult(msg, msg), library: null };
    }
    const mapped = mapRecordsToCompanyGroups(records, [
        ...(opts.globalHotkeys || []),
        ...localNonCompanyHotkeys(opts.library),
    ]);
    if (!mapped.phrasesSynced) {
        const msg = `飞书表共 ${records.length} 行，但没有可同步的公司话术（内容为空或归属非公司），本地未改动`;
        return { result: { ...emptyResult(msg, msg), skipped: mapped.skipped }, library: null };
    }
    // 飞书负责内容，本地收藏和使用记录按稳定 ID 保留。
    const previous = new Map((opts.library.groups || []).flatMap(g => (g.phrases || []).map(p => [p.id, p])));
    for (const g of mapped.groups) for (const p of g.phrases) {
        const old = previous.get(p.id);
        if (old) for (const key of ['favorite', 'useCount', 'lastUsedAt', 'createdAt']) if (old[key] !== undefined) p[key] = old[key];
    }
    const { library, groupsReplaced } = replaceCompanyGroups(opts.library, mapped.groups);
    const parts = [
        `已同步${regionLabel}公司主库：${mapped.groups.length} 个公司分组、${mapped.phrasesSynced} 条话术`,
        `替换本地公司分组 ${groupsReplaced} 个`,
    ];
    if (mapped.skipped)
        parts.push(`跳过 ${mapped.skipped} 行`);
    if (mapped.hotkeyCleared.length)
        parts.push(`${mapped.hotkeyCleared.length} 个冲突热键已清空`);
    return {
        result: {
            ok: true,
            region,
            message: parts.join('，'),
            groupsReplaced,
            phrasesSynced: mapped.phrasesSynced,
            skipped: mapped.skipped,
            hotkeyCleared: mapped.hotkeyCleared,
        },
        library,
    };
}
