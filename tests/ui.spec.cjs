const {test,expect}=require('@playwright/test');
const fs=require('fs');
const path=require('path');
const fakeClient=`(() => {
 window.__authCalls=[];let callback;let user=location.hash.includes('access_token')?{id:'11111111-1111-4111-8111-111111111111',email:'tester@example.test'}:null;
 window.__spots=Array.from({length:13},(_,i)=>({id:'12345678-1234-4234-8234-'+String(i).padStart(12,'0'),lat:45.4,lng:13.66,place:'Grad Buje, Croatia · a deliberately long title to verify wrapping and controls',country:'Croatia',country_code:'HR',added_by:'Contributor',spotted_on:'2026-06-29',image_url:'/nett-hier-sticker.webp',note:'A sticker photo and note',owner_id:null}));
 class Query{
 constructor(){this.after=null;this.size=500;}
 select(){return this;}gte(){return this;}lte(){return this;}or(){return this;}eq(){return this;}order(){return this;}limit(n){this.size=n;return this;}gt(k,v){this.after=v;return this;}
 then(resolve){resolve({data:window.__spots.filter(s=>!this.after||s.id>this.after).slice(0,this.size),error:null});}
 }
 window.supabase={createClient:()=>({from:()=>new Query(),rpc:async name=>({data:name==='nh_map_page'?{spots:window.__spots,next:null}:name==='nh_stats'?{total:10013,countries:[{code:'HR',name:'Croatia',count:10013}]}:[{lat:45.4,lng:13.66,count:13}],error:null}),auth:{
  getSession:async()=>({data:{session:user?{user,access_token:'mock-user'}:null},error:null}),
  onAuthStateChange:cb=>{callback=cb;if(location.hash.includes('type=recovery'))setTimeout(()=>cb('PASSWORD_RECOVERY',{user}),10);return {data:{subscription:{unsubscribe(){}}}};},
  signUp:async args=>{window.__authCalls.push(['signup',args]);return {data:{user:null,session:null},error:null};},
  signInWithPassword:async args=>{window.__authCalls.push(['signin',args]);user={id:'11111111-1111-4111-8111-111111111111',email:args.email};callback('SIGNED_IN',{user});return {data:{user},error:null};},
  resend:async args=>{window.__authCalls.push(['resend',args]);return {error:null};},
  resetPasswordForEmail:async(email,args)=>{window.__authCalls.push(['recovery',{email,...args}]);return {error:null};},
  updateUser:async args=>{window.__authCalls.push(['update',args]);return {error:null};},
  signOut:async()=>{user=null;callback('SIGNED_OUT',null);return {error:null};}
 }})};
})();`;
async function setup(page){
 await page.route('https://cdn.jsdelivr.net/**',async route=>{
  const url=route.request().url();
  if(url.includes('leaflet')&&url.endsWith('.css'))return route.fulfill({path:require.resolve('leaflet/dist/leaflet.css'),contentType:'text/css'});
  if(url.includes('leaflet')&&url.endsWith('.js'))return route.fulfill({path:require.resolve('leaflet/dist/leaflet.js'),contentType:'application/javascript'});
  return route.fulfill({body:fakeClient,contentType:'application/javascript'});
 });
 await page.route('https://challenges.cloudflare.com/**',route=>route.fulfill({body:'window.turnstile={render:()=>1,reset:()=>{},getResponse:()=>"test-token"};',contentType:'application/javascript'}));
 await page.route('https://tile.openstreetmap.org/**',route=>route.fulfill({body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a45sAAAAASUVORK5CYII=','base64'),contentType:'image/png'}));
 await page.route('https://ukkvukdzmdzpertbjjnp.supabase.co/functions/v1/public-api',async route=>{
  const payload=route.request().postDataJSON();let result={};
  if(payload.action==='config')result={ready:true,turnstileSiteKey:'test'};
  if(payload.action==='moderator')result={moderator:false};
  if(payload.action==='geocode')result={place:'Grad Buje, Croatia',country:'Croatia',countryCode:'HR'};
  return route.fulfill({json:result});
 });
}
test.beforeEach(async({page})=>setup(page));
test('all five designs have a common artwork envelope, stable captions and wrapping navigation',async({page},info)=>{
 await page.goto('/');await page.getByRole('button',{name:'Stickers',exact:true}).click();
 await expect(page.locator('.sticker-artwork canvas')).toHaveCount(5);
 let original;
 for(let i=0;i<5;i++){
  const canvas=page.locator('[data-sticker-slide="'+i+'"] canvas');await expect(canvas).toBeVisible();
  const shape=await canvas.evaluate(el=>{const c=el.getContext('2d'),d=c.getImageData(0,0,720,720).data;let x0=720,y0=720,x1=0,y1=0;for(let y=0;y<720;y++)for(let x=0;x<720;x++){if(d[(y*720+x)*4+3]>100){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}}const b=el.getBoundingClientRect();return {edge:Math.max(x1-x0+1,y1-y0+1),cx:(x0+x1)/2,cy:(y0+y1)/2,top:b.top,left:b.left,width:b.width,height:b.height};});
  expect(shape.edge).toBeGreaterThanOrEqual(697);expect(shape.edge).toBeLessThanOrEqual(702);expect(Math.abs(shape.cx-360)).toBeLessThan(2);expect(Math.abs(shape.cy-360)).toBeLessThan(2);
  if(original){expect(shape.top).toBe(original.top);expect(shape.width).toBe(original.width);}else original=shape;
  await expect(page.locator('#stickerPosition')).toContainText((i+1)+' of 5');
  await page.screenshot({path:info.outputPath('sticker-'+(i+1)+'.png'),fullPage:true});
  await page.getByRole('button',{name:'Next accepted sticker'}).click();
 }
 await expect(page.locator('#stickerPosition')).toContainText('1 of 5');
 await page.getByRole('button',{name:'Previous accepted sticker'}).click();await expect(page.locator('#stickerPosition')).toContainText('5 of 5');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('13 nearby sightings keep popup open for arrows, wrap, select, keyboard and touch at several zooms',async({page},info)=>{
 await page.goto('/');await page.locator('.sighting-cluster').first().click();await page.locator('.sighting-cluster').first().click();
 const markers=page.locator('.nett-marker-icon');await expect(markers).toHaveCount(13);await markers.first().click({force:true});
 const popup=page.locator('.sighting-popup');await expect(popup).toBeVisible();
 const next=page.getByRole('button',{name:'Next nearby sighting'}),previous=page.getByRole('button',{name:'Previous nearby sighting'});
 const check=async(text)=>{await expect(popup).toBeVisible();await expect(popup.locator('[role="status"]')).toHaveText(text);await expect(page.locator('.nett-marker-icon.is-selected')).toHaveCount(1);};
 await page.locator('#nearbySighting').selectOption({index:0});await check('1 of 13');await next.click();await check('2 of 13');await previous.click();await check('1 of 13');await previous.click();await check('13 of 13');
 await next.click();await check('1 of 13');await page.locator('#nearbySighting').selectOption({index:5});await check('6 of 13');
 await next.focus();await page.keyboard.press('ArrowRight');await check('7 of 13');
 if(info.project.name==='phone'){await next.tap();await check('8 of 13');}
 expect(await popup.locator('.leaflet-popup-content').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 for(const control of [next,previous]){const a=await control.boundingBox(),b=await popup.boundingBox();expect(a.x).toBeGreaterThanOrEqual(b.x);expect(a.x+a.width).toBeLessThanOrEqual(b.x+b.width);}
 await page.screenshot({path:info.outputPath('popup.png'),fullPage:true});
 await page.getByRole('button',{name:'Zoom in'}).click();await expect(popup).toBeVisible();await next.click();await expect(popup).toBeVisible();
});
test('email errors explain resend, and all outgoing auth emails target the production Pages path',async({page})=>{
 await page.goto('/#error=access_denied&error_code=otp_expired');await expect(page.locator('#accountDialog')).toBeVisible();
 await expect(page.locator('#accountMessage')).toContainText('expired');await expect(page.locator('#accountMessage')).toContainText('localhost');
 await page.locator('#accountEmail').fill('ordinary-user@example.test');await page.locator('#resendConfirmation').click();
 await expect(page.locator('#accountMessage')).toContainText('fresh email');await page.locator('#forgotPassword').click();
 await page.locator('#accountPassword').fill('test-password-1234');await page.locator('#signUpButton').click();
 const calls=await page.evaluate(()=>window.__authCalls);const expected='https://george31ga31.github.io/nett-hier-map/';
 expect(calls.find(x=>x[0]==='resend')[1].options.emailRedirectTo).toBe(expected);
 expect(calls.find(x=>x[0]==='signup')[1].options.emailRedirectTo).toBe(expected);
 expect(calls.find(x=>x[0]==='recovery')[1].redirectTo).toBe(expected);
 expect(page.url()).not.toContain('error=');
});
test('successful confirmation updates account state and recovery saves a new password',async({page})=>{
 await page.goto('/#access_token=test&type=signup');await expect(page.locator('#accountButton')).toHaveText('Account');await expect(page.locator('#accountMessage')).toContainText('Email confirmed');
 await page.goto('/?flow=recovery#access_token=test&type=recovery');await expect(page.locator('#accountHeading')).toHaveText('Choose a new password');await page.locator('#accountPassword').fill('new-password-1234');await page.locator('#signInButton').click();
 await expect(page.locator('#accountMessage')).toContainText('Password updated');
});
test('statistics use the global total, and public nickname/consent are visible before submission',async({page})=>{
 await page.goto('/');await expect(page.locator('#spotCount')).toHaveText('10013');
 await page.getByRole('button',{name:'Stats',exact:true}).click();await expect(page.locator('#statsTotal')).toHaveText('10013');
 await page.locator('#addButton').click();await page.locator('#map').click({position:{x:180,y:210}});
 await expect(page.locator('#sightingDialog')).toBeVisible();await expect(page.locator('#publicConsentWrap')).toContainText('exact map pin');
 await expect(page.locator('#addedByInput')).toHaveAttribute('placeholder','Your public nickname');
});

test('existing accounts can still sign in with a six-character password',async({page})=>{
 await page.goto('/');await page.locator('#accountButton').click();
 await page.locator('#accountEmail').fill('existing@example.test');await page.locator('#accountPassword').fill('abc123');await page.locator('#signInButton').click();
 await expect(page.locator('#accountButton')).toHaveText('Account');
});

test('privacy contact form is reachable by scrolling on desktop and a narrow phone',async({page})=>{
 await page.goto('/privacy.html');await page.locator('#supportSubmit').scrollIntoViewIfNeeded();
 await expect(page.locator('#supportSubmit')).toBeInViewport();
 await page.locator('#supportText').fill('Please remove a sensitive location.');
 await page.locator('#supportSubmit').click();
 await expect(page.locator('#supportMessage')).toContainText('private request');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
