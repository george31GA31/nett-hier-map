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
});

test('admin can move a legacy point without changing its author and delete another user’s point', async ({page}) => {
  const errors = await setup(page, {role:'admin',spots:[spot('legacy',{owner_id:null,added_by:null}),spot('owned',{lat:2,lng:2,owner_id:OWNER})]});
  await expect(page.locator('#feedbackTab')).toBeVisible();
  await openPin(page);
  await page.getByRole('button',{name:'Move point',exact:true}).click();
  await page.evaluate(() => window.__map.fire('click',{latlng:L.latLng(0.5,0.75)}));
  await expect(page.locator('#dialogTitle')).toHaveText('Move this sticker');
  await expect(page.locator('#metadataFields')).toBeHidden();
  await page.locator('#submitButton').click();
  await expect(page.locator('#sightingDialog')).toBeHidden();
  const move = (await page.evaluate(() => window.__test.writes))[0];
  expect(move.payload).toMatchObject({lat:0.5,lng:0.75,place:'Moved location, Malta'});
  expect(move.payload).not.toHaveProperty('owner_id');
  expect(move.payload).not.toHaveProperty('added_by');
  expect(move.filters).toEqual([['id','eq','legacy']]);
  await openPin(page, 2, 2);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button',{name:'Delete',exact:true}).click();
  await expect(page.locator('#modeBadge')).toHaveText('Sighting deleted');
  expect((await page.evaluate(() => window.__test.writes))[1].filters).toEqual([['id','eq','owned']]);
  expect(errors).toEqual([]);
});

test('submitted report appears in admin Feedback and can be resolved or reopened', async ({page}) => {
  const errors = await setup(page, {spots:[spot('reported',{owner_id:null})]});
  await openPin(page);
  await page.getByRole('button',{name:'Report sighting',exact:true}).click();
  await page.locator('#reportReason').selectOption('Other');
  await page.locator('#reportComment').fill('<b>Wrong position</b>');
  await page.locator('#submitReport').click();
  await expect(page.locator('#reportMessage')).toContainText('Report sent to the admin');
  await expect(page.locator('#reportDialog')).toBeHidden();
  await page.locator('#accountButton').click();
  await page.locator('#accountEmail').fill('admin@example.com');
  await page.locator('#accountPassword').fill('test-password');
  await page.locator('#signInButton').click();
  await expect(page.locator('#accountDialog')).toBeHidden();
  await page.locator('#feedbackTab').click();
  await expect(page.locator('.feedback-card')).toHaveCount(1);
  await expect(page.locator('.feedback-copy')).toContainText('<b>Wrong position</b>');
  await expect(page.locator('.feedback-copy b')).toHaveCount(0);
  await page.screenshot({path:'test-results/feedback-desktop.png'});
  await page.getByRole('button',{name:'Mark as resolved',exact:true}).click();
  await expect(page.locator('#feedbackList')).toHaveText('No open reports.');
  await page.locator('#feedbackFilter').selectOption('resolved');
  await page.getByRole('button',{name:'Reopen',exact:true}).click();
  await page.locator('#feedbackFilter').selectOption('open');
  await page.getByRole('button',{name:'View on map',exact:true}).click();
  await expect(page.getByRole('button',{name:'Move point',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('signing out discards a delayed private report response', async ({page}) => {
  await setup(page, {role:'admin',feedbackDelay:500,spots:[spot('private')],reports:[{id:'report',spot_id:'private',reason:'Wrong location',status:'open',reported_at:'2026-10-01T00:00:00Z'}]});
  await expect(page.locator('#feedbackTab')).toBeVisible();
  await page.locator('#feedbackTab').click();
  await page.locator('#accountButton').click();
  await page.locator('#signOutButton').click();
  await expect(page.locator('#feedbackTab')).toBeHidden();
  await expect(page.locator('#feedbackView')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__test.user)).toBeNull();
  await page.waitForTimeout(600);
  await expect(page.locator('#feedbackList')).toBeEmpty();
});

test('a delayed admin-membership response cannot grant the next signed-in user admin UI', async ({page}) => {
  await setup(page, {role:'admin',adminDelay:350});
  await page.evaluate(() => window.__test.switchUser('owner'));
  await page.waitForTimeout(500);
  await expect(page.locator('#feedbackTab')).toBeHidden();
});
