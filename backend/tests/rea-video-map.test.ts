import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mapBreakdownToStoryboards,
  mapBreakdownToAssets,
  type ReaVideoBreakdown,
} from '../src/services/rea-video-map'

const breakdown: ReaVideoBreakdown = {
  shots: [
    {
      index: 1, start: 0, end: 5, duration: 5,
      base: { label_zh: 'AI 生成视频' },
      aspects: { framing: { result: { shot_size: 'medium shot' } }, camera: { result: { move: 'static', support_zh: '固定机位' } } },
    },
    { index: 2, start: 5, end: 10, duration: 5, base: { label_zh: 'AI 生成视频' } },
    { index: 3, start: 10, end: 15, duration: 5, base: { label_zh: 'AI 生成视频' } },
    { index: 4, start: 15, end: 20, duration: 5, base: { label_zh: 'AI 生成视频' } },
  ],
  production_plan: {
    units: [
      { id: 'G1', shots: [1, 2], prompt: '人物以 @图片1 为准。参考 @视频1 的动作、运镜和剪辑节奏。镜头推进。', image_prompt: 'ip1' },
      { id: 'G2', shots: [3, 4], prompt: 'p2', image_prompt: 'ip2' },
    ],
  },
  whole_video_vlm: {
    style: '古风',
    characters: [
      { id: 'A', name: '女主', look: '白裙', role: '主角', shots: [1, 2] },
      { id: 'B', name: '男主', look: '青衫', role: '主角', shots: [3, 4] },
    ],
    scenes: [
      { id: 'S1', where: '宫殿', when: '白天', look: '红金', shots: [1, 2] },
      { id: 'S2', where: '集市', when: '白天', look: '热闹', shots: [3, 4] },
    ],
    props: [
      { name: '团扇', note: '女主手持', shots: [1, 2] },
      { name: '宝剑', note: '男主佩剑', shots: [3, 4] },
    ],
  },
}

test('shots aggregate into ~10s segments instead of one-per-unit', () => {
  const seeds = mapBreakdownToStoryboards(breakdown)
  assert.equal(seeds.length, 2) // 20s → 2 段，而不是 4 个 shot 或 2 个 unit 各自成段
  assert.equal(seeds[0].duration, 10)
  assert.equal(seeds[1].duration, 10)
})

test('segment binds dominant scene + appearing characters + props', () => {
  const seeds = mapBreakdownToStoryboards(breakdown)

  assert.equal(seeds[0].title, '宫殿')
  assert.equal(seeds[0].sceneKey, 'S1')
  assert.deepEqual(seeds[0].characterKeys, ['A'])
  assert.deepEqual(seeds[0].propKeys, ['团扇'])

  assert.equal(seeds[1].title, '集市')
  assert.equal(seeds[1].sceneKey, 'S2')
  assert.deepEqual(seeds[1].characterKeys, ['B'])
  assert.deepEqual(seeds[1].propKeys, ['宝剑'])
})

test('segment merges prompts from covering units and lists sub-shots', () => {
  const seeds = mapBreakdownToStoryboards(breakdown)

  assert.match(seeds[0].videoPrompt!, /镜头推进/)
  assert.equal(seeds[0].imagePrompt, 'ip1')
  assert.match(seeds[0].description!, /【镜头1】/)
  assert.match(seeds[0].description!, /【镜头2】/)
  assert.match(seeds[0].description!, /0\.0s–5\.0s/)

  assert.equal(seeds[1].videoPrompt, 'p2')
  assert.match(seeds[1].description!, /【镜头1】/)
})

test('rea-video @图片/@视频 tags are translated to huobao convention', () => {
  const seeds = mapBreakdownToStoryboards(breakdown)
  assert.match(seeds[0].videoPrompt!, /@女主/)
  assert.doesNotMatch(seeds[0].videoPrompt!, /@图片1/)
  assert.doesNotMatch(seeds[0].videoPrompt!, /@视频1/)
})

test('a short trailing segment is merged into the previous one', () => {
  const short = { ...breakdown, shots: [
    ...breakdown.shots!.slice(0, 3),
    { index: 4, start: 15, end: 16, duration: 1, base: { label_zh: 'AI 生成视频' } },
  ] } as ReaVideoBreakdown
  const seeds = mapBreakdownToStoryboards(short)
  // 15s 主段 + 1s 尾巴 → 并入后应只有 1 段（或 2 段，最后一段不 <4s）
  assert.ok(seeds.length <= 2)
  const last = seeds[seeds.length - 1]
  assert.ok(last.duration >= 4)
})

test('cast maps to character / scene / prop seeds with key preserved', () => {
  const assets = mapBreakdownToAssets(breakdown)

  assert.equal(assets.characters.length, 2)
  assert.equal(assets.characters[0].key, 'A')
  assert.equal(assets.characters[0].name, '女主')
  assert.equal(assets.characters[0].appearance, '白裙')

  assert.equal(assets.scenes.length, 2)
  assert.equal(assets.scenes[0].key, 'S1')
  assert.equal(assets.scenes[0].location, '宫殿')

  assert.equal(assets.props.length, 2)
  assert.equal(assets.props[0].key, '团扇')
  assert.equal(assets.props[0].name, '团扇')
})

test('no cast yields empty assets', () => {
  const assets = mapBreakdownToAssets({ shots: [], production_plan: { units: [] } })
  assert.deepEqual(assets, { characters: [], scenes: [], props: [] })
})
