import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// An implicit grid track is sized to max-content: one long unbreakable child widened the 390px trip page to 414px.
// Mobile page grids therefore pin their single column to minmax(0,1fr).
const PAGES = ['src/components/Trip/TripView.jsx', 'src/components/Route/PublicSharePage.jsx', 'src/components/My/MyPage.jsx'];

test('mobile page grids use a shrinkable single column', () => {
  for (const file of PAGES) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const grids = source.match(/className="[^"]*\bgrid\b[^"]*\blg:grid-cols-\[minmax\(0,1fr\)_[^"]*"/g) ?? [];
    assert.ok(grids.length > 0, `${file} has a responsive page grid`);
    for (const className of grids) assert.match(className, /(?:^|\s|")grid-cols-\[minmax\(0,1fr\)\]/, `${file}: ${className}`);
  }
});
