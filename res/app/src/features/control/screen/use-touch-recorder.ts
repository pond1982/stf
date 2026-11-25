import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import type {Control} from '@/core/control'

type Phase = 'down' | 'move' | 'up'
interface Sample {phase: Phase; at: number; x: number; y: number}
type Mode = 'idle' | 'recording' | 'playing'

function load(key: string): Sample[] {
  try {
    const data: Sample[] = JSON.parse(sessionStorage.getItem(key) || '[]')
    let down = false
    let previous = 0
    for (const e of data) {
      if (!Number.isFinite(e.at) || e.at < previous ||
          ![e.x, e.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1) ||
          !(down ? e.phase === 'up' || e.phase === 'move' : e.phase === 'down')) return []
      previous = e.at
      down = e.phase !== 'up'
    }
    return Array.isArray(data) && !down ? data : []
  }
  catch { return [] }
}

// The tape contains only completed single-finger gestures in device coordinates.
export function useTouchRecorder(serial: string, enabled: boolean, control: Control, screenId: string | null) {
  const key = 'stf.touch-recording.' + serial
  const tape = useRef<Sample[]>([])
  const pending = useRef<Sample[]>([])
  const origin = useRef(0)
  const [count, setCount] = useState(0)
  const [mode, setMode] = useState<Mode>('idle')
  const current = useRef<Mode>('idle')
  const cancelPlayback = useRef<(() => void) | null>(null)

  const stop = useCallback(() => {
    current.current = 'idle'
    pending.current = []
    cancelPlayback.current?.()
    cancelPlayback.current = null
    setMode('idle')
  }, [])

  useLayoutEffect(() => {
    tape.current = load(key)
    setCount(tape.current.filter(e => e.phase === 'up').length)
    return stop
  }, [key, stop])

  useLayoutEffect(() => {
    // Changing sessions, losing ownership, hiding the screen or disconnecting cancels pending input.
    return stop
  }, [enabled, control, screenId, stop])

  useEffect(() => {
    function changed() { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', changed)
    window.addEventListener('blur', stop)
    return () => {
      document.removeEventListener('visibilitychange', changed)
      window.removeEventListener('blur', stop)
    }
  }, [stop])

  function record() {
    if (!enabled || current.current !== 'idle') return
    current.current = 'recording'
    origin.current = performance.now()
    pending.current = []
    // Replace the old recording only after the first complete gesture.
    replaceNext.current = true
    setMode('recording')
  }
  const replaceNext = useRef(false)
  const capture = useCallback((phase: Phase, x = 0, y = 0) => {
    if (current.current !== 'recording') return
    if (phase === 'down') pending.current = []
    else if (!pending.current.length) return
    const at = Math.round(performance.now() - origin.current)
    pending.current.push({phase, x, y, at})
    if (phase === 'up') {
      if (replaceNext.current) tape.current = []
      replaceNext.current = false
      tape.current = tape.current.concat(pending.current)
      pending.current = []
      setCount(tape.current.filter(e => e.phase === 'up').length)
      try { sessionStorage.setItem(key, JSON.stringify(tape.current)) }
      catch { /* The recording remains available on the open control page. */ }
    }
  }, [key])

  const touchControl = useMemo(() => ({
    ...control,
    touchDown(seq: number, slot: number, x: number, y: number, pressure?: number) {
      if (slot === 0) capture('down', x, y)
      control.touchDown(seq, slot, x, y, pressure)
    },
    touchMove(seq: number, slot: number, x: number, y: number, pressure?: number) {
      if (slot === 0) capture('move', x, y)
      control.touchMove(seq, slot, x, y, pressure)
    },
    touchUp(seq: number, slot: number) {
      if (slot === 0) capture('up')
      control.touchUp(seq, slot)
    },
    touchReset(seq: number) { pending.current = []; control.touchReset(seq) }
  }), [control, capture])

  function play() {
    const samples = tape.current
    if (!enabled || current.current !== 'idle' || !samples.length) return
    current.current = 'playing'
    setMode('playing')
    let seq = 0
    const next = () => seq++ % 100
    let index = 0
    let down = false
    let timer: ReturnType<typeof setTimeout>
    const start = performance.now() - samples[0]!.at
    cancelPlayback.current = () => {
      clearTimeout(timer)
      if (down) {
        control.touchReset(next())
        control.gestureStop(next())
      }
    }
    function send() {
      if (current.current !== 'playing' || control.readOnly || document.hidden) return stop()
      const e = samples[index++]!
      if (e.phase === 'down') {
        control.gestureStart(next(), screenId ?? undefined)
        control.touchDown(next(), 0, e.x, e.y, 0.5)
        down = true
      }
      else if (e.phase === 'move') control.touchMove(next(), 0, e.x, e.y, 0.5)
      else control.touchUp(next(), 0)
      control.touchCommit(next())
      if (e.phase === 'up') {
        control.gestureStop(next())
        down = false
      }
      if (index === samples.length) return stop()
      timer = setTimeout(send, Math.max(0, start + samples[index]!.at - performance.now()))
    }
    send()
  }
  return {mode, count, record, play, stop, touchControl}
}
