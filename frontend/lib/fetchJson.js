export async function fetchJsonOrThrow(response, fallbackMessage) {
  const text = await response.text()
  let payload = null

  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(fallbackMessage)
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error || fallbackMessage)
  }

  if (!payload) {
    throw new Error(fallbackMessage)
  }

  return payload
}
