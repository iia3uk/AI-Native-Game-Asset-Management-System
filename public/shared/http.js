export const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })

export async function json(url, options) {
  const response = await fetch(url, options)
  const body = await response.json().catch(() => null)
  if (!response.ok || !body) throw new Error(body?.error || 'Локальный сервер вернул HTTP ' + response.status)
  return body
}
