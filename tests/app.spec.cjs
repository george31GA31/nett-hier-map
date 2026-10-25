const { test, expect } = require('playwright/test');
const { setup, spot, plotAt, openPin, fillSighting, OWNER } = require('./browser-fixture.cjs');

test('country ranks are ordinal and equal totals share a rank', async ({page}) => {
  const spots = [spot('a', {country:'Germany',country_code:'DE'}), spot('b',{country:'Germany',country_code:'DE'}), spot('c',{country:'Germany',country_code:'DE'}),
    spot('d',{country:'United Kingdom',country_code:'GB'}), spot('e',{country:'United Kingdom',country_code:'GB'}), spot('f'), spot('g',{country:'United States',country_code:'US'})];
  const errors = await setup(page, {spots});
  await page.getByRole('button', {name:'Stats', exact:true}).click();
  await expect(page.locator('.country-rank')).toHaveText(['1st','2nd','3rd','3rd']);
  await expect(page.locator('.country-label')).toHaveText(['Germany','United Kingdom','Malta','United States']);
  await expect(page.locator('#feedbackTab')).toBeHidden();
  expect(errors).toEqual([]);
});

test('nearby photo and same/different choices work on a phone, including several neighbours', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const errors = await setup(page, {spots:[spot('a'),spot('b',{lat:0.000005})]});
  await plotAt(page);
  await expect(page.locator('#duplicateDialog')).toBeVisible();
  await expect(page.locator('#duplicatePhoto')).toHaveAttribute('src', /a\.jpg$/);
  await page.locator('#duplicateDifferent').click();
  await expect(page.locator('#duplicatePosition')).toContainText('Sticker 2 of 2');
  await expect(page.locator('#duplicatePhoto')).toHaveAttribute('src', /b\.jpg$/);
  await page.screenshot({path:'test-results/nearby-mobile.png'});
  await page.locator('#duplicateSame').click();
  await expect(page.locator('#duplicateDialog')).toBeHidden();
  await expect(page.locator('#sightingDialog')).toBeHidden();
  expect(await page.evaluate(() => window.__test.uploads)).toBe(0);
  expect(errors).toEqual([]);
});

test('different sticker proceeds to upload and insert once', async ({page}) => {
  const errors = await setup(page, {spots:[spot('existing')]});
  await plotAt(page);
  await page.locator('#duplicateDifferent').click();
  await expect(page.locator('#sightingDialog')).toBeVisible();
  await fillSighting(page);
  await page.locator('#submitButton').click();
  await expect(page.locator('#sightingDialog')).toBeHidden();
  expect(await page.evaluate(() => window.__test.uploads)).toBe(1);
  const writes = await page.evaluate(() => window.__test.writes);
  expect(writes).toHaveLength(1);
  expect(writes[0].payload.owner_id).toBeNull();
  expect(errors).toEqual([]);
});

test('fresh nearby query finds stickers absent from the loaded map and Escape cancels', async ({page}) => {
  await setup(page, {spots:[],serverSpots:[spot('server-only')]});
  await plotAt(page);
  await expect(page.locator('#duplicatePhoto')).toHaveAttribute('src', /server-only\.jpg$/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#duplicateDialog')).toBeHidden();
  await expect(page.locator('#sightingDialog')).toBeHidden();
  await plotAt(page, 0.00002, 0);
  await expect(page.locator('#sightingDialog')).toBeVisible();
});

test('new neighbours are checked again before an upload starts', async ({page}) => {
  const late = spot('late');
  await setup(page);
  await plotAt(page);
  await fillSighting(page);
  await page.evaluate(late => window.__test.serverSpots.push(late), late);
  await page.locator('#submitButton').click();
  await expect(page.locator('#duplicateDialog')).toBeVisible();
  expect(await page.evaluate(() => window.__test.uploads)).toBe(0);
  await page.locator('#duplicateSame').click();
  await expect(page.locator('#sightingDialog')).toBeHidden();
  expect(await page.evaluate(() => window.__test.writes)).toEqual([]);
});

test('failed nearby check can be retried without bypassing the warning', async ({page}) => {
  await setup(page, {spots:[spot('near')],nearbyError:true});
  await plotAt(page);
  await expect(page.locator('#modeBadge')).toContainText('Could not check nearby stickers');
  await expect(page.locator('#sightingDialog')).toBeHidden();
  await page.evaluate(() => window.__test.nearbyError = false);
  await plotAt(page);
  await expect(page.locator('#duplicateDialog')).toBeVisible();
});

test('cancelled submission cannot open a late duplicate prompt over a new draft', async ({page}) => {
  await setup(page);
  await plotAt(page);
  await fillSighting(page);
  await page.evaluate(late => { window.__test.serverSpots.push(late); window.__test.nearbyDelay = 500; }, spot('late'));
  await page.locator('#submitButton').click();
  await page.locator('#cancelDialog').click();
  await page.evaluate(() => window.__test.nearbyDelay = 0);
  await plotAt(page, 10, 10);
  await expect(page.locator('#sightingDialog')).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.locator('#duplicateDialog')).toBeHidden();
  await expect(page.locator('#coordinateText')).toContainText('10.00000, 10.00000');
  expect(await page.evaluate(() => window.__test.uploads)).toBe(0);
});

test('owners get their usual controls; other points are reportable', async ({page}) => {
  await setup(page, {role:'owner',spots:[spot('own'),spot('other',{lat:1,lng:1,owner_id:null})]});
  await openPin(page);
  await expect(page.getByRole('button',{name:'Edit sighting',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Move point',exact:true})).toHaveCount(0);
  await expect(page.locator('#feedbackTab')).toBeHidden();
  await openPin(page, 1, 1);
  await expect(page.getByRole('button',{name:'Report sighting',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Delete',exact:true})).toHaveCount(0);
  expect(await page.evaluate(() => window.__test.reads.some(read => read.table === 'site_admins' || read.table === 'spot_reports'))).toBe(false);
});

