import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { OfficeSound } from '../src/client/sound.js';

function setup(t: TestContext, { failFirst = false } = {}) {
  const input = new EventTarget();
  const stats = { contexts: 0, resumes: 0, buffers: 0 };
  const param = () => ({ value: 0, setTargetAtTime: () => {} });
  const bus = () => ({ gain: param(), connect: (to: object) => to });
  const bindings = {
    window: input,
    document: Object.assign(new EventTarget(), { hidden: false }),
    AudioContext: class {
      state = 'suspended';
      currentTime = 0;
      sampleRate = 1000;
      destination = {};
      createAnalyser = bus;
      createGain = bus;
      createDynamicsCompressor = () => ({ ...bus(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
      createPanner = () => ({ ...bus(), positionX: param(), positionY: param(), positionZ: param() });
      createBiquadFilter = () => ({ ...bus(), frequency: param(), Q: param() });

      constructor() {
        stats.contexts++;
        if (failFirst && stats.contexts === 1) throw new Error('No audio until input');
      }

      createBuffer(_channels: number, size: number) {
        stats.buffers++;
        return { getChannelData: () => new Float32Array(size) };
      }

      async resume() {
        stats.resumes++;
        this.state = 'running';
      }
    },
  };
  for (const [key, value] of Object.entries(bindings)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  return { sound: new OfficeSound(), input, stats };
}

test('loading opens the audio device once without starting playback or synthesizing sound samples', (t) => {
  const { sound, input, stats } = setup(t);
  sound.prepare();
  sound.prepare();
  assert.deepEqual(stats, { contexts: 1, resumes: 0, buffers: 0 });
  assert.equal(sound.state, 'locked');

  input.dispatchEvent(new Event('keydown'));
  assert.equal(sound.state, 'running');
  assert.equal(stats.contexts, 1, 'the first key must not reopen the device');
  assert.ok(stats.buffers > 0);
  assert.ok(stats.resumes > 0);

  const afterUnlock = { ...stats };
  sound.prepare();
  input.dispatchEvent(new Event('pointerdown'));
  assert.deepEqual(stats, afterUnlock);
});

test('the first input still unlocks sound when loading could not open an audio device', (t) => {
  const { sound, input, stats } = setup(t, { failFirst: true });
  sound.prepare();
  assert.deepEqual(stats, { contexts: 1, resumes: 0, buffers: 0 });
  input.dispatchEvent(new Event('pointerdown'));
  assert.equal(stats.contexts, 2);
  assert.equal(sound.state, 'running');
});
