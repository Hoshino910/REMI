#!/usr/bin/env node
// Deterministic fixture generation only. This script never connects to DSH or an LLM.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { estimateTokens } from '../../core/dist/index.js'

const output = resolve(process.argv[2] ?? '.dsh-memory/long-dialogue-v02')
let anchors = [
  ['长测甲：霁川盒包装', '霁川盒包装颜色只能使用银灰色，禁止使用橙红色。', { color: '银灰色', forbiddenColor: '橙红色' }, '请回溯最早的霁川盒包装约定，输出颜色和禁止颜色。'],
  ['长测甲：霁川盒交付', '霁川盒交付日期为 2027-03-18，验收暗号为 榛子64。', { date: '2027-03-18', code: '榛子64' }, '请回溯最早的霁川盒交付约定，输出交付日期和验收暗号。'],
  ['长测甲：栖原服务连接', '栖原服务的测试端口为 6389，连接模式只能使用只读。', { port: 6389, mode: '只读' }, '请回溯最早的栖原服务连接约定，输出端口和连接模式。'],
  ['长测甲：栖原服务备份', '栖原服务每周三 02:40 备份，备份文件扩展名为 .qybak。', { schedule: '每周三 02:40', extension: '.qybak' }, '请回溯最早的栖原服务备份约定，输出时间和扩展名。'],
  ['长测乙：澄屿盒包装', '澄屿盒包装颜色只能使用浅紫色，禁止使用荧光黄色。', { color: '浅紫色', forbiddenColor: '荧光黄色' }, '请回溯最早的澄屿盒包装约定，输出颜色和禁止颜色。'],
  ['长测乙：澄屿盒交付', '澄屿盒交付日期为 2027-06-23，验收暗号为 桦果82。', { date: '2027-06-23', code: '桦果82' }, '请回溯最早的澄屿盒交付约定，输出交付日期和验收暗号。'],
  ['长测乙：泊岑服务连接', '泊岑服务的测试端口为 7526，连接模式只能使用离线。', { port: 7526, mode: '离线' }, '请回溯最早的泊岑服务连接约定，输出端口和连接模式。'],
  ['长测乙：泊岑服务备份', '泊岑服务每周六 04:15 备份，备份文件扩展名为 .pcvault。', { schedule: '每周六 04:15', extension: '.pcvault' }, '请回溯最早的泊岑服务备份约定，输出时间和扩展名。'],
]

// Fresh synthetic facts for an independent full rerun after ranking changes.
const fresh = process.argv.includes('--fresh')
const freshV3 = process.argv.includes('--fresh-v3')
if (fresh) {
  const replacements = [
    ['霁川', '岚汀'], ['栖原', '霜禾'], ['澄屿', '砚溪'], ['泊岑', '岳棠'],
    ['银灰色', '湖绿色'], ['橙红色', '玫红色'], ['2027-03-18', '2028-04-12'], ['榛子64', '杉叶39'],
    ['6389', '8247'], ['只读', '本地直连'], ['每周三 02:40', '每周二 01:25'], ['.qybak', '.shsnap'],
    ['浅紫色', '米白色'], ['荧光黄色', '亮蓝色'], ['2027-06-23', '2028-09-21'], ['桦果82', '栗枝57'],
    ['7526', '9361'], ['离线', '内网隔离'], ['每周六 04:15', '每周五 03:50'], ['.pcvault', '.ytarchive'],
  ]
  const change = value => replacements.reduce((result, [from, to]) => result.replaceAll(from, to), String(value))
  anchors = anchors.map(([title, fact, expected, query]) => [change(title), change(fact), Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, typeof value === 'number' ? Number(change(value)) : change(value)])), change(query)])
}

if (freshV3) anchors = [
  ['长测甲：雾岬盒包装', '雾岬盒的包装采用石青色，不得采用珊瑚粉色。', {color:'石青色',forbiddenColor:'珊瑚粉色'}, '之前给雾岬盒定下的包装用色和禁用色分别是什么？'],
  ['长测甲：雾岬盒交付', '雾岬盒在 2029-02-16 交付，验收时核对口令 鹿铃28。', {date:'2029-02-16',code:'鹿铃28'}, '雾岬盒交付安排中的日期及验收口令各是什么？'],
  ['长测甲：槐序服务连接', '槐序服务连接走 5173 端口，只允许局域网直连模式。', {port:5173,mode:'局域网直连'}, '槐序服务当初选定的连接端口与模式是什么？'],
  ['长测甲：槐序服务备份', '槐序服务的备份安排是每周一 05:35，文件以 .hseq 作为扩展名。', {schedule:'每周一 05:35',extension:'.hseq'}, '槐序服务原定在什么时候备份，备份扩展名是什么？'],
  ['长测乙：汀雁盒包装', '汀雁盒的包装采用鸢尾紫色，不得采用柠檬黄色。', {color:'鸢尾紫色',forbiddenColor:'柠檬黄色'}, '帮我找回汀雁盒最初指定的包装颜色，以及明确不准使用的颜色。'],
  ['长测乙：汀雁盒交付', '汀雁盒在 2029-11-08 交付，验收时核对口令 苔石63。', {date:'2029-11-08',code:'苔石63'}, '汀雁盒最早的交付安排：哪天交付，验收要对哪个口令？'],
  ['长测乙：榆笺服务连接', '榆笺服务连接走 6894 端口，只允许单机回环模式。', {port:6894,mode:'单机回环'}, '找回榆笺服务最初的连接设置，给出端口号和允许的模式。'],
  ['长测乙：榆笺服务备份', '榆笺服务的备份安排是每周四 06:45，文件以 .yjnote 作为扩展名。', {schedule:'每周四 06:45',extension:'.yjnote'}, '榆笺服务最早定的备份周期、时刻和文件扩展名，请从早期记录找回。'],
]

const themes = freshV3 ? ['虚构播客编排','海洋标本陈列','轨道交通动线','天文观测笔记','冰场标识设计','社区合唱排练','古籍装帧讨论','沙丘摄影构图','雨声采集方案','纸船浮力实验','壁画观看路径','陶器触感描述'] : ['桌面收纳', '虚构展览', '公园导览', '厨房布局', '纸质拼图', '窗边植物', '图书分类', '露营清单', '舞台布景', '城市步行', '棋盘规则', '手工灯罩']
const objects = ['木片', '纸筒', '布袋', '圆环', '方盒', '隔板', '长绳', '软垫', '标签', '支架', '托盘', '卡片']
const sentence = (round, line, theme, object) => freshV3 ? [
  `片段${round}/${line}的${theme}先提出一个观察问题：${object}若位于边缘，观众是否会忽略细节？这只是当页草稿，尚无实施约定。`,
  `在第${round}页第${line}条${theme}札记里，尝试把${object}当作参照物，对比近处与远处的层次；这里的讨论不涉及任何盒子或服务。`,
  `${theme}的第${round}-${line}次推演描述${object}与周边空白的关系，作者认为可以先观察再记录，也有人持不同意见，暂不作结论。`,
  `围绕${theme}草稿${round}-${line}，讨论者交换了关于${object}的局部看法；本段不包含交付、备份或连接参数，也不替代已经确认的事实。`,
  `资料页${round}-${line}仅为${theme}保存一段假设：${object}可能改变视觉停留位置，但假设需要后续检查，不能直接变成长久规则。`,
  `${theme}旁注${round}-${line}建议描写${object}被观察到的过程，不给作品评分；这份零散材料与前面项目完全无关，不要求记住或合并。`,
][line % 6] : [
  `素材记录${round}-${line}围绕${theme}展开，${object}放在左侧入口附近；这里只描述局部布置，不改变其他项目的要求。`,
  `在${theme}草图${round}-${line}中，${object}用于区分远近层次，观察者先看前景再看背景，具体尺寸暂不确定。`,
  `第${round}组第${line}项${theme}材料讨论${object}的移动顺序，先核对位置再调整间距，所有数字仅用于这份素材编号。`,
  `${theme}练习${round}-${line}的${object}需要留出手部操作空间，边缘不与其他元素重合，这是一条独立的虚构设计建议。`,
  `关于${theme}的片段${round}-${line}，${object}可以形成重复节奏，但重复次数只属于当前片段，不是长期项目约定。`,
  `观察${theme}样稿${round}-${line}时，${object}的轮廓应当容易辨认，说明文字保持简短，不要把这个样稿并入其他任务。`,
][line % 6]

const stages = []
const add = (stage, text, extra = {}) => stages.push({ index: stages.length + 1, stage, text, ...extra })
add('setup', '这是独立的虚构超长对话验收。所有轮次只在聊天中回答，不调用工具、不搜索网页、不读写文件、不执行命令。事实只以明确给出的约定为准，不能确认就说查不到。除回溯题外，仅回复简短确认，不复述或总结早期事实。现在只回复 LONG_TEST_READY。')
for (const [title, fact] of anchors) add('anchor', `${title}。必须保留的虚构约定：${fact}只回复“约定已收到”，不要复述具体内容。`)
for (let round = 1; round <= 96; round++) {
  const theme = themes[(round - 1) % themes.length]
  let text = `独立干扰素材第${round}轮：${theme}。下面内容仅属于本轮素材，不更新之前任何项目约定。只回复“素材${round}已收到”，不要总结早期事实。\n`
  for (let line = 1; text.length < 1800; line++) text += sentence(round, line, theme, objects[(line + round) % objects.length]) + '\n'
  add('interference', text, { round, theme })
}
for (const [title, , , query] of anchors.slice(0, 4)) add('recall-before-compaction', `${query}只输出相应字段的 JSON，不猜测、不调用工具。`, { target: title })
// This is a DSH command, not an LLM message. Never queue it as an ordinary prompt.
add('control', '/compact', { command: 'compact' })
// Held-out set: these answers were NOT asked for immediately before compaction.
for (const [title, , , query] of anchors.slice(4)) add('recall-after-compaction', `${query}只输出相应字段的 JSON，不猜测、不调用工具。`, { target: title })
add('unknown-control', '我们最早约定的“未设定仓库”的仓库地址是什么？没有明确约定就回答“未约定”，不要猜测，不调用工具。')

const prompts = stages.filter(s => s.stage !== 'control')
const inputTokens = prompts.reduce((sum, s) => sum + estimateTokens(s.text), 0)
let history = 0
let cumulative = 0
for (const s of prompts) { history += estimateTokens(s.text); cumulative += history }
const manifest = {
  schemaVersion: 1,
  fixture: freshV3 ? 'remi-v02-long-dialogue-96-clean-v3' : fresh ? 'remi-v02-long-dialogue-96-fresh' : 'remi-v02-long-dialogue-96',
  remoteCallsMade: 0,
  interferenceRounds: 96,
  modelPrompts: prompts.length,
  controlCommands: 1,
  inputChars: prompts.reduce((sum, s) => sum + s.text.length, 0),
  uniqueInputEstimatedTokens: inputTokens,
  cumulativeInputEstimatedTokensWithoutCompaction: cumulative,
  notes: [
    'Token estimates use REMI heuristic, not the provider tokenizer.',
    'Cumulative estimate excludes system prompt, runtime snapshots, reasoning and answers; ignores compaction and cache billing.',
    'Current DSH reports a 1,000,000-token window; this corpus will not necessarily trigger automatic compaction.',
    'Pre-compaction recall is native-long-context plus retrieval; post-compaction uses held-out targets, but active-surface absence must still be checked.',
  ],
}

if (new Set(stages.filter(s=>s.stage==='interference').map(s=>s.text)).size !== 96) throw new Error('Duplicate interference prompts')
for (const [, fact] of anchors) if (stages.filter(s=>s.stage==='interference').some(s=>s.text.includes(fact))) throw new Error('Anchor leaked into interference')
mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'messages.jsonl'), stages.map(s => JSON.stringify(s)).join('\n') + '\n')
writeFileSync(resolve(output, 'ground-truth.json'), JSON.stringify(anchors.map(([target, , expected]) => ({target, expected})), null, 2))
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
writeFileSync(resolve(output, 'messages.zh-CN.md'), '# REMI 超长对话消息清单\n\n逐条发送并等待完成；不要整份粘贴为单条消息。control 项在 DSH 命令通道执行。\n\n' + stages.map(s=>`## ${s.index}. ${s.stage}\n\n\`\`\`text\n${s.text}\n\`\`\`\n`).join('\n'))
console.log(JSON.stringify({output, ...manifest}, null, 2))
