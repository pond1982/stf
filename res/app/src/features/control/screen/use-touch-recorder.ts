import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import type {Control} from '@/core/control'

type Phase = 'down' | 'move' | 'up'
interface Sample {phase: Phase; at: number; x: number; y: number}
type Mode = 'idle' | 'recording' | 'playing' | 'looping'
const LOOP_PAUSE_MS = 500

function validSamples(value: unknown): value is Sample[] {
  if (!Array.isArray(value)) return false
  let down = false
  let previous = 0
  for (const e of value) {
    if (!e || !Number.isSafeInteger(e.at) || e.at < previous ||
        ![e.x, e.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1) ||
        !(down ? e.phase === 'up' || e.phase === 'move' : e.phase === 'down')) return false
    previous = e.at
    down = e.phase !== 'up'
  }
  return !down
}

function load(key: string): Sample[] {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(key) || '[]')
    return validSamples(data) ? data : []
  }
  catch { return [] }
}

// The tape contains only completed single-finger gestures in device coordinates.
export function useTouchRecorder(serial: string, enabled: boolean, control: Control, screenId: string | null) {
  const key = 'stf.touch-recording.' + serial
  const tape = useRef<Sample[]>([])
  const fileRequest = useRef(0)
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
    return () => { fileRequest.current++; stop() }
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

  const updateTape = useCallback((samples: Sample[]) => {
    tape.current = samples
    setCount(samples.filter(e => e.phase === 'up').length)
    try { sessionStorage.setItem(key, JSON.stringify(samples)) }
    catch { /* The recording remains available on the open control page. */ }
  }, [key])

  function exportFile() {
    const contents = {format: 'stf-gestures', version: 1, samples: tape.current}
    return new Blob([JSON.stringify(contents)], {type: 'application/json'})
  }

  async function importFile(file: Blob) {
    const request = ++fileRequest.current
    const contents = JSON.parse(await file.text())
    if (request !== fileRequest.current || current.current !== 'idle') return
    if (contents?.format !== 'stf-gestures' || contents.version !== 1 ||
        !validSamples(contents.samples) || !contents.samples.length) {
      throw new Error('Choose a valid STF gesture recording saved with Save.')
    }
    updateTape(contents.samples.map(({phase, at, x, y}: Sample) => ({phase, at, x, y})))
    return true
  }

  function record() {
    if (!enabled || current.current !== 'idle') return
    fileRequest.current++
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
      updateTape(replaceNext.current ? pending.current : tape.current.concat(pending.current))
      replaceNext.current = false
      pending.current = []
    }
  }, [updateTape])

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

  function play(repeat = false) {
    const samples = tape.current
    if (!enabled || current.current !== 'idle' || !samples.length) return
    fileRequest.current++
    const playbackMode = repeat ? 'looping' : 'playing'
    current.current = playbackMode
    setMode(playbackMode)
    let seq = 0
    const next = () => seq++ % 100
    let index = 0
    let down = false
    let timer: ReturnType<typeof setTimeout>
    let start = 0
    cancelPlayback.current = () => {
      clearTimeout(timer)
      if (down) {
        control.touchReset(next())
        control.gestureStop(next())
      }
    }
    function send() {
      if (current.current !== playbackMode || control.readOnly || document.hidden) return stop()
      if (index === 0) start = performance.now() - samples[0]!.at
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
      if (index === samples.length) {
        if (!repeat) return stop()
        index = 0
        timer = setTimeout(send, LOOP_PAUSE_MS)
        return
      }
      timer = setTimeout(send, Math.max(0, start + samples[index]!.at - performance.now()))
    }
    send()
  }
  return {mode, count, record, play, stop, touchControl, exportFile, importFile}
}
