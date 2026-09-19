// Strict field scoring for flat JSON or a wrapper keyed by the target project.
const aliases = { color: ['颜色', '包装颜色', 'color'], forbiddenColor: ['禁止颜色', '禁用颜色', 'forbiddenColor'], date: ['交付日期', '发货日期', '日期', 'date'], code: ['验收暗号', '暗号', 'code'], port: ['端口', '测试端口', 'port'], mode: ['连接模式', '模式', 'mode'], schedule: ['备份时间', '时间', '备份计划', 'schedule'], extension: ['扩展名', '文件扩展名', '备份文件扩展名', 'extension'] }
const canonical = value => String(value).normalize('NFKC').replace(/年|月/gu, '-').replace(/日/gu, '').replace(/\s+/gu, ' ').trim()
export function scoreFields(answer, expected, target) {
  const project = canonical(target.replace(/^长测[甲乙][:：]/u, ''))
  let json
  try {
    json = JSON.parse(answer.replace(/^\s*```(?:json)?\s*/iu, '').replace(/\s*```\s*$/u, ''))
    const wrapper = Object.keys(json).find(key => canonical(key) === project)
    if (wrapper !== undefined) json = json[wrapper]
    const named = json['项目'] ?? json.project
    if (named !== undefined && canonical(named) !== project) json = undefined
  } catch { json = undefined }
  return Object.entries(expected).map(([key, value]) => {
    const values = json && typeof json === 'object' && !Array.isArray(json)
      ? (aliases[key] ?? [key]).filter(alias => Object.hasOwn(json, alias)).map(alias => json[alias]) : []
    return { key, expected: value, correct: Boolean(values.length && values.every(actual => actual !== null && canonical(actual) === canonical(value))) }
  })
}
