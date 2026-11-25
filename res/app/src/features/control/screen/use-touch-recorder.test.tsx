import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import type {Control} from '@/core/control'
import {useTouchRecorder} from './use-touch-recorder'

const controls = {gestureStart: vi.fn(), touchDown: vi.fn(), touchUp: vi.fn(),
  touchCommit: vi.fn(), gestureStop: vi.fn(), touchReset: vi.fn()} as unknown as Control
let root: ReturnType<typeof createRoot>
let recorder: ReturnType<typeof useTouchRecorder>

function Harness() {
  recorder = useTouchRecorder('test-phone', true, controls, 'screen')
  return null
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  sessionStorage.setItem('stf.touch-recording.test-phone', JSON.stringify([
    {phase: 'down', at: 2000, x: 0.3, y: 0.4}, {phase: 'up', at: 2050, x: 0, y: 0}
  ]))
  root = createRoot(document.createElement('div'))
  act(() => root.render(<Harness />))
})
afterEach(() => {
  act(() => root.unmount())
  sessionStorage.removeItem('stf.touch-recording.test-phone')
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('replays one pass for Play', () => {
  act(() => recorder.play())
  act(() => vi.advanceTimersByTime(2000))
  expect(controls.touchDown).toHaveBeenCalledTimes(1)
  expect(controls.touchUp).toHaveBeenCalledTimes(1)
  expect(recorder.mode).toBe('idle')
})

it('repeats complete gestures until Stop and cancels the next pass', () => {
  act(() => recorder.play(true))
  act(() => vi.advanceTimersByTime(1150))
  expect(controls.touchDown).toHaveBeenCalledTimes(3)
  expect(controls.touchUp).toHaveBeenCalledTimes(3)
  expect(recorder.mode).toBe('looping')
  act(() => recorder.stop())
  act(() => vi.advanceTimersByTime(2000))
  expect(controls.touchDown).toHaveBeenCalledTimes(3)
  expect(recorder.mode).toBe('idle')
})

it('resets a held touch and stops looping on focus loss', () => {
  act(() => recorder.play(true))
  act(() => window.dispatchEvent(new Event('blur')))
  act(() => vi.advanceTimersByTime(2000))
  expect(controls.touchReset).toHaveBeenCalledTimes(1)
  expect(controls.touchDown).toHaveBeenCalledTimes(1)
  expect(recorder.mode).toBe('idle')
})
