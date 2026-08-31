/**
 * One-time deployment migration for windeng/aqiu context layout.
 *
 * Usage (HappyClaw must be stopped):
 *   npx tsx scripts/migrate-context-v2.ts --apply
 *
 * The operation is deliberately idempotent: Profile updates converge, Memory
 * writes use stable idempotency keys, and the scheduled task is updated in
 * place. Database schema migration/backup remains owned by initDatabase().
 */
import '../src/load-env.js';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { CronExpressionParser } from 'cron-parser';

import {
  acquireDatabaseMaintenanceGuard,
  DATABASE_MAINTENANCE_TOKEN_ENV,
  releaseDatabaseMaintenanceGuard,
} from '../src/database-maintenance.js';

const AQIU_USERNAME = 'aqiu';
const CONTEXT_AUDIT_TASK_ID = 'task-1774459646386-rbrij6';
const CONTEXT_AUDIT_CRON = '0 4 * * 0';
const MIGRATION_SOURCE_ID = 'context-v2-migration-20260831';
const DATABASE_PATH = path.join(process.cwd(), 'data', 'db', 'messages.db');
const execFileAsync = promisify(execFile);

const PROFILE = {
  identityPrompt: `你是 HappyClaw，在 aqiu 的 workspace 中作为阿秋的长期教学工作伙伴。称呼用户为“阿秋”。主要支持 K12 语文和 HSK 对外汉语教学；默认使用简体中文，并以非技术用户能直接理解的方式交流。`,
  soulPrompt: `质量优先、实用导向、减负为先。教学内容要专业准确、可直接用于课堂；建议应可落地，不给阿秋增加无谓操作。日常沟通亲切温暖，但不空泛。用户当前说明高于旧记忆或参考资料。`,
  agentsPrompt: `开始任务时先召回相关 Workspace Memory，再按 knowledge-base 索引只读取命中的教学参考。只有学段、教材范围、目标、时长或学生水平等关键变量会实质改变结果时才简短确认，并尽量给出默认方案；简单修改直接执行。完成后检查内容准确性和成品可用性。收到纠正时先完成当前任务，再判断是否为稳定、可复用信息：短小事实/决定/经验/待办更新 Memory，长篇方法提议更新知识库；一次性反馈不持久化，也不为每次纠正新增规则。`,
  toolsPrompt: `涉及教材原文、古诗文、政策或可能变化的信息时使用可靠来源核实。生成 Word、PPT、HTML 等文件后先验证能打开和内容完整，再通过当前渠道实际投递。阿秋当前偏好是 QQ 对话优先邮件交付、飞书对话优先直接发送文件，除非她当次另有说明。只有投递工具确认成功后才能声称“已发送”；失败时如实说明。不要让阿秋读取服务器路径、运行命令或处理内部技术细节。`,
} as const;

const MEMORY_ITEMS = [
  {
    kind: 'fact',
    title: '阿秋的教学角色与当前学段',
    canonicalKey: 'aqiu.profile.teaching-role',
    content:
      '称呼为阿秋；K12 语文教师兼 HSK 对外汉语教师，所在地为广东江门，默认使用简体中文和 Asia/Shanghai 时区。当前常见教学范围是一年级、五年级、九年级，主要使用部编版（人教版）教材。',
    importance: 0.95,
    confidence: 0.95,
  },
  {
    kind: 'decision',
    title: '面向阿秋的沟通方式',
    canonicalKey: 'aqiu.communication.nontechnical',
    content:
      '阿秋不是技术用户。解释应直接、通俗、少术语；不要让她读取服务器路径、执行命令或处理内部配置。复杂教辅任务只确认会实质改变结果的关键细节，并提供省事的默认方案。',
    importance: 0.95,
    confidence: 1,
  },
  {
    kind: 'decision',
    title: '文件交付渠道偏好',
    canonicalKey: 'aqiu.delivery.channel-policy',
    content:
      '当前偏好：QQ 对话产生的文件优先发到已配置的默认邮箱；飞书对话优先直接发送文件；当次明确要求优先。生成文件不等于交付，只有投递工具返回成功后才能说“已发送”。',
    importance: 0.98,
    confidence: 1,
  },
  {
    kind: 'decision',
    title: '教学产出的质量标准',
    canonicalKey: 'aqiu.teaching.quality-bar',
    content:
      '教学产出以专业准确、课堂可直接使用和减少阿秋工作量为标准；交付前检查字词、拼音、释义、文学常识、格式和文件可用性。建议要可实践、省力，避免空泛理论和额外负担。',
    importance: 0.95,
    confidence: 1,
  },
  {
    kind: 'lesson',
    title: '中文教学文档的排版偏好',
    canonicalKey: 'aqiu.documents.typography',
    content:
      '练习和试卷正文使用楷体，标题可用宋体加粗，英文可用 Arial。中文文档使用全角标点和配对弯引号“”‘’，不用 ASCII 直引号；省略号用……，破折号用——。',
    importance: 0.9,
    confidence: 1,
  },
  {
    kind: 'fact',
    title: 'HSK 学生背景与分层难点',
    canonicalKey: 'aqiu.hsk.student-context',
    content:
      'HSK 入门班包含已学习一个多学期的老生和零基础新生，学生母语背景包括西班牙语、英语、韩语、日语等。设计材料时需要兼顾两组水平，拼音准确，按需要选择性双语，并优先采用不增加教师备课量的分层方案。该班级情况最初观察于 2026 年 3 月，使用前如已过去较久应向阿秋轻量确认。',
    importance: 0.92,
    confidence: 0.9,
  },
  {
    kind: 'fact',
    title: '阿秋的常见任务',
    canonicalKey: 'aqiu.teaching.common-tasks',
    content:
      '常见任务包括教案与课件、出卷和评讲 PPT、作文与试卷批改、课文范文仿写、双语学习材料、互动 HTML 小游戏，以及教学资料检索整理。',
    importance: 0.8,
    confidence: 0.95,
  },
  {
    kind: 'lesson',
    title: '甲骨文辅助汉字教学',
    canonicalKey: 'aqiu.teaching.oracle-bone-method',
    content:
      '阿秋常用甲骨文、金文或小篆的字形演变帮助 K12 和 HSK 学生理解汉字。适合的汉字可先让学生观察猜义，再解释字形、本义和演变，最后联系现代字义、组词与课文语境；字源有分歧时须核实并说明。',
    importance: 0.75,
    confidence: 0.95,
  },
  {
    kind: 'open_loop',
    title: '教师继续教育与定期注册跟进',
    canonicalKey: 'aqiu.teacher-registration',
    content:
      '截至 2026-04-01：历史继续教育学时经电话确认无法补修；2024、2025 年已达标，2026 年仍需完成年度要求；还需修复省专技人员继续教育系统的单位/账号匹配问题。按当时确认口径，最早预计 2028 年申请转为正常注册。政策和个人状态会变化，采取行动前必须重新核实官方要求；本条不保存任何账号、证件号或密码。',
    importance: 0.85,
    confidence: 0.85,
  },
] as const;

const AUDIT_PROMPT = `执行 aqiu Home 的每周 Context v2 健康审查。这是只读审查，不是自动整理任务。

请检查：
1. 召回当前 workspace 中相关的 active Workspace Memory，重点关注重复 canonical key、相互矛盾、明显过时的时间性事实，以及长期未关闭的 open_loop。
2. 读取 knowledge-base skill 的 references/INDEX.md，只按需检查被索引文档；确认索引链接有效、主题没有明显重复，偏好与 Memory 不冲突。
3. 对照当前注入的 Agent 工作方式，识别 Profile、Memory 和长篇 reference 之间不必要的重复或边界错放。

约束：
- 不写入或删除 Memory，不修改 Profile、skill、文件或 Git 仓库，不执行 git 命令。
- 不调用 send_message、send_file、邮件或其他外发工具。
- 用户当前说明高于旧记录；可能变化的政策、班级状态和渠道能力只能标记“需核实”，不能自行断言。
- 结果写入本次任务记录：先给“正常 / 需处理”结论，再列最多 10 条具体建议；每条注明目标位置（Profile / Memory canonical key / reference 文件）。如果没有问题，简短写“Context v2 审查正常，无需变更”。`;

function printUsage(): void {
  console.log('Usage: npx tsx scripts/migrate-context-v2.ts --apply');
}

function parseArgs(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }
  if (args.length !== 1 || args[0] !== '--apply') {
    printUsage();
    throw new Error('Refusing to mutate context without exactly --apply');
  }
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function assertServiceStopped(): Promise<void> {
  const port = Number.parseInt(process.env.WEB_PORT || '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid WEB_PORT: ${process.env.WEB_PORT}`);
  }
  if (
    (await canConnect('127.0.0.1', port)) ||
    (await canConnect('::1', port))
  ) {
    throw new Error(`HappyClaw still listens on port ${port}; stop it first`);
  }
}

async function assertDatabaseUnused(): Promise<void> {
  const candidates = [
    DATABASE_PATH,
    `${DATABASE_PATH}-wal`,
    `${DATABASE_PATH}-shm`,
    `${DATABASE_PATH}-journal`,
  ].filter((candidate) => fs.existsSync(candidate));
  if (candidates.length === 0) {
    throw new Error(`Database not found: ${DATABASE_PATH}`);
  }
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-t', '--', ...candidates],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    throw new Error(
      `Database is still open by process(es): ${stdout.trim().split(/\s+/).join(', ')}`,
    );
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    if (
      commandError.code === 1 &&
      !commandError.stdout?.trim() &&
      !commandError.stderr?.trim()
    ) {
      return;
    }
    if (error instanceof Error && error.message.startsWith('Database is ')) {
      throw error;
    }
    throw new Error(`Unable to prove database is unused: ${String(error)}`);
  }
}

async function main(): Promise<void> {
  parseArgs();
  await assertServiceStopped();

  const guard = acquireDatabaseMaintenanceGuard(DATABASE_PATH);
  process.env[DATABASE_MAINTENANCE_TOKEN_ENV] = guard.token;
  let db: typeof import('../src/db.js') | undefined;
  try {
    await assertDatabaseUnused();
    db = await import('../src/db.js');
    const { createWorkspaceMemory } = await import('../src/memory-service.js');
    db.initDatabase();

    const aqiu = db.getUserByUsername(AQIU_USERNAME);
    if (!aqiu || aqiu.status !== 'active' || aqiu.role !== 'member') {
      throw new Error('Expected active member user aqiu was not found');
    }
    const homeJid = `web:home-${aqiu.id}`;
    const homeFolder = `home-${aqiu.id}`;
    const home = db.getRegisteredGroup(homeJid);
    if (!home || home.folder !== homeFolder || home.created_by !== aqiu.id) {
      throw new Error(
        'aqiu Home workspace does not match the expected owner/folder',
      );
    }

    const currentProfile = db.getOrCreateDefaultAgentProfile(aqiu.id);
    const profile = db.updateAgentProfile(currentProfile.id, aqiu.id, {
      ...PROFILE,
      promptMode: 'append',
      changeSource: 'migration',
    });
    if (!profile)
      throw new Error('Failed to update aqiu default Agent Profile');

    const memoryResults = MEMORY_ITEMS.map((item) =>
      createWorkspaceMemory({
        actor: { id: aqiu.id, role: aqiu.role },
        workspaceJid: homeJid,
        sourceType: 'migration',
        provenance: {
          sourceId: MIGRATION_SOURCE_ID,
          observedAt: '2026-08-31T00:00:00.000Z',
        },
        ...item,
        status: 'active',
        idempotencyKey: `context-v2:${item.canonicalKey}`,
      }),
    );

    const task = db.getTaskById(CONTEXT_AUDIT_TASK_ID);
    if (!task || task.deleted_at || task.group_folder !== homeFolder) {
      throw new Error('Expected aqiu context audit task was not found');
    }
    const nextRun = CronExpressionParser.parse(CONTEXT_AUDIT_CRON, {
      tz: process.env.TZ || 'Asia/Shanghai',
      currentDate: new Date(),
    })
      .next()
      .toDate()
      .toISOString();
    db.updateTask(CONTEXT_AUDIT_TASK_ID, {
      prompt: AUDIT_PROMPT,
      schedule_type: 'cron',
      schedule_value: CONTEXT_AUDIT_CRON,
      context_mode: 'isolated',
      execution_type: 'agent',
      next_run: nextRun,
      status: 'active',
      notify_channels: null,
      chat_jid: homeJid,
      delivery_route_jid: homeJid,
      group_folder: homeFolder,
    });
    db.updateTaskWorkspace(CONTEXT_AUDIT_TASK_ID, homeJid, homeFolder);

    console.log(
      JSON.stringify(
        {
          schemaVersion: db.CURRENT_SCHEMA_VERSION,
          aqiuUserId: aqiu.id,
          homeJid,
          profile: {
            id: profile.id,
            version: profile.version,
            contextSource: profile.runtime_policy.context.source,
            skillsMode: profile.runtime_policy.skills.mode,
          },
          memoryItems: memoryResults.map((result) => ({
            canonicalKey: result.item.canonicalKey,
            replayed: result.replayed,
          })),
          auditTask: {
            id: CONTEXT_AUDIT_TASK_ID,
            nextRun,
            workspaceJid: homeJid,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    if (db?.isDatabaseInitialized()) db.closeDatabase();
    delete process.env[DATABASE_MAINTENANCE_TOKEN_ENV];
    releaseDatabaseMaintenanceGuard(guard.lockPath, guard.token);
  }
}

void main().then(
  () => setImmediate(() => process.exit(0)),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    setImmediate(() => process.exit(1));
  },
);
