import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import type {Control} from '@/core/control'
import {useTouchRecorder} from './use-touch-recorder'

const controls = {gestureStart: vi.fn(), touchDown: vi.fn(), touchUp: vi.fn(),
  touchCommit: vi.fn(), gestureStop: vi.fn(), touchReset: vi.fn()} as unknown as Control
let root: ReturnType<typeof createRoot>
let recorder: ReturnType<typeof useTouchRecorder>

function Harness({serial = 'test-phone'}: {serial?: string}) {
  recorder = useTouchRecorder(serial, true, controls, 'screen')
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
  sessionStorage.removeItem('stf.touch-recording.other-phone')
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

it('imports a saved recording on another device and preserves its taps and timing', async() => {
  const saved = recorder.exportFile()
  act(() => root.render(<Harness serial="other-phone" />))
  expect(recorder.count).toBe(0)
  await act(async() => { await recorder.importFile(saved) })
  expect(recorder.count).toBe(1)
  expect(controls.touchDown).not.toHaveBeenCalled()
  expect(await recorder.exportFile().text()).toBe(await saved.text())
  act(() => recorder.play())
  expect(controls.touchDown).toHaveBeenCalledWith(1, 0, 0.3, 0.4, 0.5)
  act(() => vi.advanceTimersByTime(49))
  expect(controls.touchUp).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(1))
  expect(controls.touchUp).toHaveBeenCalledTimes(1)
})

it('preserves the current recording when a file has an incomplete gesture', async() => {
  const original = await recorder.exportFile().text()
  const bad = JSON.parse(original)
  bad.samples.pop()
  await expect(recorder.importFile(new Blob([JSON.stringify(bad)]))).rejects.toThrow()
  expect(await recorder.exportFile().text()).toBe(original)
})

it('discards an import that finishes after switching devices', async() => {
  let finish!: (text: string) => void
  const file = recorder.exportFile()
  const original = await file.text()
  vi.spyOn(file, 'text').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const importing = recorder.importFile(file)
  act(() => root.render(<Harness serial="other-phone" />))
  finish(original)
  await importing
  expect(recorder.count).toBe(0)
})
