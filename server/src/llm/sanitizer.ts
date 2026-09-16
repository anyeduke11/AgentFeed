const SENSITIVE_PATTERNS = [
  /\b(?:sk|api_key|apikey|token|secret|password|pwd|passwd)\b\s*[:=]\s*[^\s"',;\]\)]+/gi,
  /(?:https?:\/\/)[^@\n]+@[^\s]+/gi,
  /Bearer\s+[^\s"',;]+/gi,
  /\b(?:access_key|accessKey|client_secret|clientSecret)\b\s*[:=]\s*[^\s"',;]+/gi
]

export function sanitizeSensitive(text: string): string {
  let out = text
  for (const re of SENSITIVE_PATTERNS) {
    out = out.replace(re, '[REDACTED]')
  }
  return out
}

export function looksSensitive(text: string): boolean {
  const checks = [
    /(?:sk|api_key|apikey|token|secret|password|pwd|passwd)/i,
    /Bearer/i,
    /client_secret|clientSecret|access_key|accessKey/i
  ]
  return checks.some(re => re.test(text))
}
