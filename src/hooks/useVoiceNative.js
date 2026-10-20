import { useCallback, useEffect, useRef, useState } from 'react'
import { dlog } from '../platform/log'

// Android native speech recognition. All permission requests happen after the user taps the mic.
const MESSAGES = {
  unsupported: 'سرویس تشخیص گفتار روی گوشی پیدا نشد. سرویس Speech Services by Google را نصب/به‌روز کن و زبان فارسی را فعال کن.',
  denied_native: 'اجازه میکروفون یا تشخیص گفتار داده نشد. از تنظیمات گوشی ← برنامه‌ها ← دفترچه یادداشت ← مجوزها، میکروفون را فعال کن.',
  nospeech: 'صدایی به متن تبدیل نشد. اینترنت، زبان فارسی و سرویس تشخیص گفتار گوشی را بررسی کن و دوباره بگو.',
  busy: 'میکروفون در اختیار برنامه دیگری است. تماس یا برنامه ضبط صدا را ببند و دوباره امتحان کن.',
  network: 'سرویس تشخیص گفتار به شبکه دسترسی ندارد. اینترنت را بررسی کن.',
  unknown: 'تشخیص گفتار با خطا متوقف شد.',
}

let SRPromise
const getSR = () => {
  if (!SRPromise) SRPromise = import('@capacitor-community/speech-recognition').then((m) => m.SpeechRecognition)
  return SRPromise
}
const MAX_MS = 25000

export default function useVoiceNative({ onFinal }) {
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState(null)
  const activeRef = useRef(false)
  const startingRef = useRef(false)
  const manualRef = useRef(false)
  const lastRef = useRef('')
  const listenersRef = useRef([])
  const timersRef = useRef([])

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((id) => clearTimeout(id))
    timersRef.current = []
  }, [])
  const later = useCallback((fn, ms) => {
    const id = setTimeout(() => {
      timersRef.current = timersRef.current.filter((x) => x !== id)
      fn()
    }, ms)
    timersRef.current.push(id)
    return id
  }, [])
  const dropListeners = useCallback(() => {
    listenersRef.current.forEach((h) => { try { h.remove() } catch {} })
    listenersRef.current = []
  }, [])

  const fail = useCallback((code, extra = '') => {
    dlog('voice', `${code}${extra ? ` · ${extra}` : ''}`)
    activeRef.current = false
    clearTimers()
    dropListeners()
    setError({ code, message: `${MESSAGES[code] || MESSAGES.unknown}${extra ? ` (${extra})` : ''}`, device: '' })
    setListening(false)
    setInterim('')
  }, [clearTimers, dropListeners])

  const finish = useCallback(() => {
    if (!activeRef.current) return
    activeRef.current = false
    clearTimers()
    dropListeners()
    const text = lastRef.current.trim()
    lastRef.current = ''
    setListening(false)
    setInterim('')
    dlog('voice', text ? `final-result chars=${text.length}` : 'recognition ended without text')
    if (text) onFinalRef.current(text)
    else if (!manualRef.current) setError({ code: 'nospeech', message: MESSAGES.nospeech, device: '' })
  }, [clearTimers, dropListeners])

  const stop = useCallback(async () => {
    try { const p = await getSR(); await p.stop() } catch (e) { dlog('voice-stop', e?.message || String(e)) }
    later(finish, 900)
  }, [finish, later])

  useEffect(() => () => {
    activeRef.current = false
    clearTimers()
    dropListeners()
    getSR().then((p) => p.stop()).catch(() => {})
  }, [clearTimers, dropListeners])

  const begin = async () => {
    setError(null)
    setInterim('')
    lastRef.current = ''
    manualRef.current = false
    let p
    try {
      p = await getSR()
      // Ask at runtime after the user action. Android permissions cannot be silently granted by an app.
      let perm = await p.checkPermissions()
      dlog('voice', `permission-before=${JSON.stringify(perm)}`)
      if (perm?.speechRecognition !== 'granted') perm = await p.requestPermissions()
      dlog('voice', `permission-after=${JSON.stringify(perm)}`)
      if (perm?.speechRecognition !== 'granted') return fail('denied_native', JSON.stringify(perm || {}))

      const availability = await p.available()
      dlog('voice', `available=${JSON.stringify(availability)}`)
      if (!availability?.available) return fail('unsupported', JSON.stringify(availability || {}))

      activeRef.current = true
      listenersRef.current = await Promise.all([
        p.addListener('partialResults', (data) => {
          if (!activeRef.current) return
          const matches = Array.isArray(data?.matches) ? data.matches : []
          const result = matches.map((s) => String(s || '').trim()).filter(Boolean).join(' ')
          if (result) {
            lastRef.current = result
            setInterim(result)
            dlog('voice-result', result)
          }
        }),
        p.addListener('listeningState', (data) => {
          dlog('voice-state', JSON.stringify(data || {}))
          if (data?.status === 'stopped') later(finish, 1000)
        }),
        p.addListener('error', (data) => {
          const message = String(data?.message || data?.error || data?.errorMessage || 'unknown')
          dlog('voice-native-error', message)
          if (/permission|denied|not allowed/i.test(message)) fail('denied_native', message)
          else if (/network|internet/i.test(message)) fail('network', message)
          else if (/busy|audio/i.test(message)) fail('busy', message)
          else fail('unknown', message)
        }),
      ])
      setListening(true)
      dlog('voice', 'starting native recognizer language=fa-IR')
      later(() => { if (activeRef.current) stop() }, MAX_MS)
      const result = await p.start({ language: 'fa-IR', maxResults: 3, partialResults: true, popup: false })
      dlog('voice-start-result', JSON.stringify(result || {}))
      const matches = Array.isArray(result?.matches) ? result.matches : []
      const text = matches.map((s) => String(s || '').trim()).filter(Boolean).join(' ')
      if (text) {
        lastRef.current = text
        setInterim(text)
        later(finish, 500)
      }
    } catch (e) {
      fail('unknown', e?.message || String(e))
    }
  }

  const start = async () => {
    if (startingRef.current || activeRef.current) return
    startingRef.current = true
    try { await begin() } finally { startingRef.current = false }
  }
  const toggle = () => {
    if (listening || activeRef.current) {
      manualRef.current = true
      return stop()
    }
    return start()
  }

  return { listening, interim, error, level: 0, device: '', meter: false, toggle, clearError: () => setError(null) }
}
