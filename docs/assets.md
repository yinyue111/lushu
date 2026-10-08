# Generated scene images (AI-generated, photorealistic)

Generated on 2026-10-08 (Asia/Taipei) with **gpt-image-2.5-sunburst** (`--hq`, requested quality `max`, requested size `1536x1024`) through the OpenAI-compatible relay. One call per image, no retries, at most two requests in flight (five batches of two). The relay does not honour the requested quality; the server-reported values are listed below.

**These are AI-generated generic scenes, not photos of any real stop or landmark.** They replace an earlier illustrated set (`illus-*`, same day) that was dropped for looking off-brand. Because they look like photographs, the UI always labels them:

- stop tiles: badge `<类别>示意图` (narrow tiles: `示意`), alt text `<类别>类地点示意图（AI 生成）`;
- city covers: badge `城市示意图 · AI 生成` on heroes, `示意` on route cards, `示意图` on the share preview;
- a stop's own real photo always wins; if a scene image fails to load the gradient + lucide icon tile is shown.

Categories `夜游`, `逛街` and the generic `地点` keep the gradient + icon tile. Temple matching also covers `庵 / 禅院 / 文殊院` (a bare `院` was not added because it would also match 剧院 / 医院 / 学院 / 书院).

Pipeline: Pillow resize + webp. `public/assets/scene-*.webp` (1216 px, city cover 1440 px) plus `md/` (1024 px) and `sm/` (640 px). The empty-state flat-lay is cropped to 4:3 around the objects (960 / 720 / 480 px) and shown as a rounded tile on white cards. Originals are kept outside the repo.

Shared style suffix appended to every prompt:

> Style: photorealistic high-end travel photography, full-frame camera, 35mm or 50mm lens, natural realistic lighting, warm natural colour grading with soft coral and golden tones, gentle contrast, no HDR look, not oversaturated, fine natural detail. A generic scene, not any specific named real-world landmark. No text, no readable signs or characters, no watermark, no logos. No identifiable faces: any people are tiny, distant, blurred or seen from behind. Main subject centered with comfortable margins so the image can be cropped to a square or to 16:9.

| File | Used for | Server-reported quality / size | Prompt (subject) |
|---|---|---|---|
| `scene-cat-temple.webp` | Stop tile, category 寺庙 (temple) | medium / 1536x1024 | A quiet generic Chinese Buddhist temple courtyard in late-afternoon light: a hall with a curved dark-tiled roof and red wooden columns, a bronze incense burner with thin rising smoke in the foreground, worn stone paving, an old ginkgo tree, shallow depth of field. |
| `scene-cat-water.webp` | Stop tile, category 湖河 (lake / river / bridge) | medium / 1536x1024 | A calm lakeside at golden hour: weeping willow branches framing the top of the shot, a small stone arched bridge in the middle distance, light mist over the water, gentle ripples, soft distant hills. |
| `scene-cat-food.webp` | Stop tile, category 吃喝 (food) | low / 1536x1024 | A close-up of Chinese food on a wooden table near a window: a bowl of hand-pulled noodles in clear broth, dim sum in a bamboo steamer with light steam, small side dishes and chopsticks, warm natural window light, shallow depth of field. |
| `scene-cat-tea.webp` | Stop tile, category 茶咖 (tea / café) | low / 1536x1024 | A teahouse and cafe table by a sunny window: a clay teapot and a small cup of green tea with rising steam next to a latte with latte art, a few loose tea leaves, soft bokeh of green plants in the background, warm natural light. |
| `scene-cat-museum.webp` | Stop tile, category 展馆 (museum / gallery) | low / 1536x1024 | Interior of a modern minimalist museum hall: tall white walls, soft skylight, a few framed abstract artworks and a sculpture on a white plinth, polished concrete floor, one distant blurred visitor seen from behind. |
| `scene-cat-mountain.webp` | Stop tile, category 山野 (mountain / village) | medium / 1536x1024 | Misty green tea-terrace hills at sunrise: curved rows of tea bushes in the foreground, layered mountain ridges fading into morning haze, a small pavilion on a distant ridge, soft warm sunlight. |
| `scene-cat-garden.webp` | Stop tile, category 园林 (garden / park) | medium / 1536x1024 | A corner of a classical Chinese garden: a round moon gate in a whitewashed wall, a sculptural limestone rockery, a koi pond with lily pads, a pavilion with upturned eaves partly visible, blossoming tree branches, soft diffused light. |
| `scene-cat-street.webp` | Stop tile, category 街巷 (old street) | medium / 1536x1024 | A narrow old-town lane in a Chinese water town in warm afternoon light: whitewashed walls with dark tiled roofs, hanging red lanterns, wooden shopfronts with completely blank signboards, a stone-paved path receding into the distance, potted plants. |
| `scene-city-generic.webp` | City cover for cities without bundled real photos (home/destination hero, route hero, route cards, share preview) | medium / 1536x1024 | A wide dusk cityscape across a river: an anonymous modern skyline with glowing windows on the far bank, the river reflecting a coral and violet sky, a low bridge with soft light trails. It must not resemble any recognizable real city and must have no famous or distinctive towers. Composition: the left half and the bottom third are darker and calm (dark water and a shadowed embankment) so large white headline text overlaid there stays readable. |
| `scene-empty-state.webp` | Empty / not-found states (My routebooks, destination without routes, creator without routes, route not found) | low / 1536x1024 | A realistic top-down flat-lay on a clean, plain, very light warm off-white surface (#faf7f2): a folded paper map showing only abstract coloured areas and lines with no labels or writing, a brass compass, a small closed notebook with a pencil, softly lit with gentle natural shadows. Lots of empty space around the objects, minimalist, centered. |
