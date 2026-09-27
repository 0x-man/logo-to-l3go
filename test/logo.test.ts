import { describe, expect, it } from 'vitest';
import { autoWidth, pixelize, LogoError, MAX_H, MAX_W } from '../src/core/logo';
import { autoPanelColor } from '../src/core/build';
import { COLOR_BY_ID } from '../src/core/palette';
import { draw, FIXTURES } from './img';

const names = (ids: number[]) => ids.map(i => COLOR_BY_ID.get(i)!.name).sort();

describe('reading a logo', () => {
  it('removes a flat white background and keeps the logo colours apart', () => {
    const g = pixelize(FIXTURES.wordmark());
    expect(g.bgMode).toBe('flat');
    expect(g.background).toEqual([255, 255, 255]);
    expect(g.colors.length).toBe(2);
    expect(names(g.colors.map(c => c.brick))).toContain('Dark Blue');
    expect(g.w / g.h).toBeGreaterThan(3);   // a wide wordmark stays wide
  });
  it('treats transparency as background', () => {
    const g = pixelize(FIXTURES.appIcon());
    expect(g.bgMode).toBe('transparent');
    expect(names(g.colors.map(c => c.brick))).toEqual(['Orange', 'White']);
    expect(g.cells[0][0]).toBe(-1);                       // rounded corner
    expect(g.cells[Math.floor(g.h / 2)][1]).toBeGreaterThanOrEqual(0);
  });
  it('uses the whole picture when there is no background', () => {
    expect(pixelize(FIXTURES.gradient()).bgMode).toBe('none');
    expect(pixelize(FIXTURES.wordmark(), { keepBackground: true }).bgMode).toBe('none');
  });
  it('honours the requested width and colour limit', () => {
    const g = pixelize(FIXTURES.appIcon(), { width: 20, maxColors: 1 });
    expect(g.w).toBe(20);
    expect(g.colors.length).toBe(1);
    expect(g.cells.length).toBe(g.h);
    expect(g.cells.every(r => r.length === g.w)).toBe(true);
  });
  it('keeps sizes within limits for extreme shapes', () => {
    for (const [w, h] of [[2000, 60], [60, 2000], [500, 500]]) {
      const g = pixelize(draw(w, h, null, x => { x.fillStyle = '#C91A09'; x.fillRect(0, 0, w, h); }));
      expect(g.w).toBeLessThanOrEqual(MAX_W);
      expect(g.h).toBeLessThanOrEqual(MAX_H);
      expect(g.w).toBeGreaterThanOrEqual(3);
    }
    expect(autoWidth(1)).toBeGreaterThanOrEqual(24);
  });
  it('says so when there is nothing to build', () => {
    expect(() => pixelize(draw(100, 100, '#FFFFFF', () => {}))).toThrow(LogoError);
    expect(() => pixelize(draw(100, 100, null, () => {}))).toThrow(LogoError);
  });
  it('picks a panel colour that matches the background, or contrasts with a light logo', () => {
    expect(autoPanelColor(pixelize(FIXTURES.wordmark()))).toBe(1);        // white
    expect(autoPanelColor(pixelize(FIXTURES.lightLoose()))).toBe(11);     // black behind a white logo
  });
});
