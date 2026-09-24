/** YAML 双引号标量转义：剥换行（防注入新键）、转义反斜杠与双引号 */
export function yamlSafe(v: string): string {
  return '"' + String(v).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** HTML 注释安全：剥换行、破坏 "-->" 终止序列（输出不得再出现 "-->"） */
export function commentSafe(v: string): string {
  return String(v).replace(/[\r\n]+/g, ' ').replace(/-->/g, '- - >')
}
