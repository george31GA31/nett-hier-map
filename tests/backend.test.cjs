const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const {PGlite}=require('@electric-sql/pglite');
let db,handler;
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const OLD='33333333-3333-4333-8333-333333333333';
const project='https://ukkvukdzmdzpertbjjnp.supabase.co';
let captchaOk=true, usedTokens=new Set(), removed=[];
async function sql(q,params=[]){return (await db.query(q,params)).rows;}
async function rpc(name,args={}){
 const keys=Object.keys(args);
 if(name==='nh_cleanup_candidates')return await sql('select * from public.nh_cleanup_candidates()');
 return (await sql(`select to_jsonb(public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')})) as value`,Object.values(args)))[0]?.value;
}
class Query {
 constructor(table){assert.ok(['spots','spot_reports'].includes(table));this.table=table;this.mode='select';this.filters=[];this.values=null;this.single=false;this.fields='*';}
 select(fields){this.fields=fields||'*';return this;}eq(k,v){this.filters.push([k,'=',v]);return this;}
 gte(k,v){this.filters.push([k,'>=',v]);return this;}lte(k,v){this.filters.push([k,'<=',v]);return this;}gt(k,v){this.filters.push([k,'>',v]);return this;}
 order(k){this.orderBy=k;return this;}limit(n){this.max=n;return this;}maybeSingle(){this.single=true;return this;}
 insert(v){this.mode='insert';this.values=v;return this;}update(v){this.mode='update';this.values=v;return this;}delete(){this.mode='delete';return this;}
 then(resolve,reject){return this.run().then(resolve,reject);}
 async run(){try{
  const values=[];const bind=v=>{values.push(v);return `$${values.length}`;};let q;
  if(this.mode==='insert'){const keys=Object.keys(this.values);q=`insert into public.${this.table}(${keys.join(',')}) values(${keys.map(k=>bind(this.values[k])).join(',')})`;}
  else if(this.mode==='update'){q=`update public.${this.table} set ${Object.keys(this.values).map(k=>`${k}=${bind(this.values[k])}`).join(',')}`;}
  else q=this.mode==='delete'?`delete from public.${this.table}`:`select ${this.fields} from public.${this.table}`;
  if(this.filters.length)q+=' where '+this.filters.map(([k,op,v])=>`${k}${op}${bind(v)}`).join(' and ');
  if(this.mode!=='select')q+=' returning '+this.fields;
  else {if(this.orderBy)q+=' order by '+this.orderBy;if(this.max)q+=' limit '+this.max;}
  const rows=await sql(q,values);return {data:this.single?(rows[0]||null):rows,error:null};
 }catch(error){return {data:null,error};}}
}
const fakeService={
 rpc:async(name,args)=>{try{return {data:await rpc(name,args),error:null};}catch(error){return {data:null,error};}},
 from:table=>new Query(table),
 auth:{getUser:async(token)=>({data:{user:token==='user-a'?{id:A,email:'a@example.test'}:token==='user-b'?{id:B,email:'b@example.test'}:null},error:!['user-a','user-b'].includes(token)}),admin:{signOut:async()=>({error:null}),deleteUser:async id=>{await sql('delete from auth.users where id=$1',[id]);return {error:null};}}},
 storage:{from:bucket=>({
  upload:async(path,bytes)=>{try{await sql('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)',[bucket,path,{size:bytes.length}]);return {error:null};}catch(error){return {error};}},
  remove:async paths=>{removed.push(...paths);for(const path of paths)await sql('delete from storage.objects where bucket_id=$1 and name=$2',[bucket,path]);return {error:null};}
 })}
};
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
 alter table storage.objects enable row level security;
 grant usage on schema storage,auth to anon,authenticated,service_role;
 grant all on all tables in schema storage to anon,authenticated,service_role;
 create function storage.extension(name text) returns text language sql as $$select split_part(name,'.',2)$$;
 create publication supabase_realtime;
 grant usage on schema public to service_role;`);
 await db.exec(fs.readFileSync('supabase.sql','utf8').replace('create extension if not exists pgcrypto;',''));
 await db.exec(fs.readFileSync('supabase_update_v6.sql','utf8'));
 await sql('insert into auth.users values($1,$2),($3,$4)',[A,'a@example.test',B,'b@example.test']);
 await sql(`insert into public.spots(id,lat,lng,place,country,country_code,added_by,image_url,owner_id) values($1,45,14,'Original','Croatia','HR','Nickname',$2,$3)`,[OLD,project+'/storage/v1/object/public/sticker-photos/legacy.jpg',A]);
 await sql(`insert into storage.objects(bucket_id,name,metadata) values('sticker-photos','legacy.jpg','{"size":100}')`);
 await db.exec(fs.readFileSync('supabase/migrations/20261021190622_public_launch.sql','utf8'));
 const secrets={SUPABASE_URL:project,SUPABASE_SERVICE_ROLE_KEY:'test-service',SUPABASE_ANON_KEY:'anon',ABUSE_HMAC_SECRET:'x'.repeat(32),TURNSTILE_SECRET_KEY:'test-secret',TURNSTILE_SITE_KEY:'test-site',OPERATIONS_TOKEN:'o'.repeat(32)};
 globalThis.Deno={env:{get:k=>secrets[k]},serve:h=>{handler=h;}};
 globalThis.testCreateClient=()=>fakeService;
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  if(String(url).includes('turnstile/v0/siteverify')){
   const token=options.body.get('response');const success=captchaOk&&!usedTokens.has(token);usedTokens.add(token);
   return Response.json({success,hostname:'george31ga31.github.io',action:'submission'});
  }
  if(String(url).includes('nominatim.'))return Response.json({address:{city:'Test city',country:'Croatia',country_code:'hr'}});
  return originalFetch(url,options);
 };
 const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const logic='data:text/javascript;base64,'+Buffer.from(compile(fs.readFileSync('supabase/functions/public-api/logic.ts','utf8'))).toString('base64');
 globalThis.testPhotoLogic=await import(logic);
 const source=fs.readFileSync('supabase/functions/public-api/index.ts','utf8').replace(/import \{ createClient \} from [^;]+;/,'const createClient=globalThis.testCreateClient;').replace(/["']\.\/logic\.ts["']/,JSON.stringify(logic));
 await import('data:text/javascript;base64,'+Buffer.from(compile(source)).toString('base64'));
});
after(async()=>{await db?.close();});
async function request(payload,user=null,photo=false){
 const headers={'x-forwarded-for':'198.51.100.'+(user==='user-a'?1:user==='user-b'?2:3)};
 if(user)headers.Authorization='Bearer '+user;
 let body;
 if(photo){body=new FormData();body.set('payload',JSON.stringify(payload));body.set('photo',new File([new Uint8Array([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,0,255,217])],'test.jpg',{type:'image/jpeg'}));}
 else {body=JSON.stringify(payload);headers['Content-Type']='application/json';}
 const r=await handler(new Request(project+'/functions/v1/public-api',{method:'POST',headers,body}));return {status:r.status,body:await r.json()};
}
const submission=()=>({action:'sighting',requestId:crypto.randomUUID(),lat:45,lng:14,place:'New',country:'Croatia',country_code:'HR',added_by:'Public nickname',note:null,spotted_on:'2026-10-20',captchaToken:crypto.randomUUID()});

test('migration preserves every existing sighting and photo',async()=>{
 const rows=await sql('select id,owner_id,photo_path from public.spots');assert.equal(rows.length,1);assert.equal(rows[0].id,OLD);assert.equal(rows[0].owner_id,A);assert.equal(rows[0].photo_path,null);
 assert.equal((await sql('select name from storage.objects'))[0].name,'legacy.jpg');
});
test('anonymous and signed-in callers cannot bypass backend writes, reports privacy or privileged RPCs',async()=>{
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  for(const q of ["select * from public.spot_reports","select * from private.support_requests","select public.nh_moderation('"+A+"','list')","insert into storage.objects(bucket_id,name) values('sticker-photos','attacker.jpg')","insert into public.spots(lat,lng,image_url) values(0,0,'x')","delete from public.spots","update public.spots set added_by='attacker'"]){
   await assert.rejects(()=>db.exec(q),/permission denied|row-level security/);
  }
  await db.exec('reset role');
 }
});
test('global pause is enforced in the database',async()=>{
 const r=await request(submission(),null,true);assert.equal(r.status,503);assert.match(r.body.error,/paused/);
 await sql('update private.launch_controls set submissions_paused=false');
});
test('CAPTCHA is server verified and failed checks cannot create storage/database rows',async()=>{
 captchaOk=false;const before=(await sql('select count(*)::int as n from storage.objects'))[0].n;
 assert.equal((await request(submission(),null,true)).status,400);captchaOk=true;
 assert.equal((await sql('select count(*)::int as n from storage.objects'))[0].n,before);
});
let owned,guest;
test('guest and signed-in uploads create correct ownership, never client-supplied ownership',async()=>{
 const input=submission();input.owner_id=B;
 const r=await request(input,'user-a',true);assert.equal(r.status,200,JSON.stringify(r.body));owned=r.body;
 assert.equal(owned.owner_id,A);assert.match(owned.image_url,/managed\//);
 const g=await request(submission(),null,true);assert.equal(g.status,200,JSON.stringify(g.body));guest=g.body;assert.equal(guest.owner_id,null);
});
test('owner can edit metadata without changing IDs, photo or ownership',async()=>{
 const r=await request({...submission(),action:'edit',id:owned.id,added_by:'New nickname'},'user-a');
 assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.id,owned.id);assert.equal(r.body.image_url,owned.image_url);assert.equal(r.body.owner_id,A);
});
test('two signed-in identities and a guest cannot change or delete another owner’s sighting/photo',async()=>{
 for(const user of ['user-b',null]){
  const r=await request({action:'delete',id:owned.id},user);assert.equal(r.status,user?403:401);
  const edit=await request({...submission(),action:'edit',id:owned.id},user);assert.equal(edit.status,user?403:401);
 }
 assert.ok((await sql('select id from public.spots where id=$1',[owned.id])).length);
 assert.ok((await sql('select name from storage.objects where name=$1',[owned.photo_path])).length);
});
test('reporting is rate-limited and reports reach the owner-only moderation inbox',async()=>{
 const r=await request({action:'report',spot_id:owned.id,reason:'Inappropriate',captchaToken:crypto.randomUUID(),reporterToken:crypto.randomUUID()});assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal((await request({action:'moderate',operation:'list'},'user-b')).status,403);
 await sql('insert into private.moderators values($1)',[B]);
 const inbox=await request({action:'moderate',operation:'list'},'user-b');assert.equal(inbox.status,200);assert.equal(inbox.body.reports.length,1);
});
test('private requests are stored only in the private owner inbox',async()=>{
 const r=await request({action:'support',message:'Please remove my private location',reply_to:'requester@example.test',captchaToken:crypto.randomUUID()});assert.equal(r.status,200);
 const inbox=await request({action:'moderate',operation:'list'},'user-b');assert.equal(inbox.body.requests[0].reply_to,'requester@example.test');
});
test('owner deletion queues and removes its photo, preserving other photos',async()=>{
 const r=await request({action:'delete',id:owned.id},'user-a');assert.equal(r.status,200,JSON.stringify(r.body));
 assert.ok(removed.includes(owned.photo_path));assert.equal((await sql('select id from public.spots where id=$1',[owned.id])).length,0);
 assert.ok((await sql('select id from storage.objects where name=$1',[guest.photo_path])).length);
});
test('failed-save pending uploads expire into cleanup; a referenced photo is never removed',async()=>{
 const pending=crypto.randomUUID();const path=await rpc('nh_photo_reserve',{request_id:pending,account_id:null});
 await sql("insert into storage.objects(bucket_id,name,metadata) values('sticker-photos',$1,'{}')",[path]);
 await sql("update private.managed_photos set created_at=now()-interval '2 hours' where path=$1",[path]);
 await sql('insert into private.photo_cleanup(path) values($1)',[guest.photo_path]);
 const candidates=await rpc('nh_cleanup_candidates');assert.ok(candidates.some(x=>x.path===path));assert.ok(!candidates.some(x=>x.path===guest.photo_path));
 const cleaned=await request({action:'maintenance'},'o'.repeat(32));assert.equal(cleaned.status,200);assert.ok(removed.includes(path));assert.ok(!removed.includes(guest.photo_path));
});
test('new account deletion removes owned sightings, retains guest data, and blocks surviving JWT writes',async()=>{
 const r=await request({action:'delete-account',confirm:'DELETE MY ACCOUNT'},'user-a');assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal((await sql('select id from public.spots where id=$1',[OLD])).length,0);assert.ok(removed.includes('legacy.jpg'));
 assert.ok((await sql('select id from public.spots where id=$1',[guest.id])).length);
 assert.equal((await request({...submission(),action:'edit',id:guest.id},'user-a')).status,403);
});
test('quota cannot be bypassed by changing guest browser tokens or creating accounts',async()=>{
 await sql('delete from private.quotas');
 const args={action:'report',actor:'f'.repeat(64)};
 for(let i=0;i<10;i++)await rpc('nh_reserve',args);
 await assert.rejects(()=>rpc('nh_reserve',args),/QUOTA_EXCEEDED/);
 await sql('delete from private.quotas');await sql('update private.launch_controls set daily_sightings=2');
 for(let i=0;i<2;i++)await rpc('nh_reserve',{action:'sighting',actor:String(i).repeat(64),upload_bytes:10});
 await assert.rejects(()=>rpc('nh_reserve',{action:'sighting',actor:'a'.repeat(64),upload_bytes:10}),/QUOTA_EXCEEDED/);
});
test('shared geocoding lease serializes all visitors and cache hits bypass upstream',async()=>{
 const first=await rpc('nh_geocode_claim',{cache_key:'test'});assert.ok(first.claimed);
 assert.ok((await rpc('nh_geocode_claim',{cache_key:'other'})).busy);
 await rpc('nh_geocode_finish',{cache_key:'test',result:{place:'Cached place'}});
 assert.equal((await rpc('nh_geocode_claim',{cache_key:'test'})).cached.place,'Cached place');
 assert.ok((await rpc('nh_geocode_claim',{cache_key:'other'})).busy);
});
test('global statistics and low-zoom clusters include more than 10,000 rows',async()=>{
 await db.exec(`insert into public.spots(lat,lng,country,country_code,image_url,added_by) select 10,10,'Germany','DE','legacy','legacy' from generate_series(1,10005)`);
 const stats=await rpc('nh_stats');assert.ok(stats.total>10000);assert.equal(stats.countries.find(c=>c.code==='DE').count,10005);
 let after=null;let count=0;do {const page=await rpc('nh_map_page',{south:-90,north:90,west:-180,east:180,after_id:after});count+=page.spots.length;after=page.next;}while(after);assert.equal(count,stats.total);
 const clusters=await rpc('nh_clusters',{south:-90,north:90,west:-180,east:180,cell:10});assert.equal(clusters.reduce((sum,c)=>sum+c.count,0),stats.total);
});

test('server strips JPEG metadata and rejects oversized dimensions and invalid images',()=>{
 const valid=new Uint8Array([255,216,255,225,0,8,69,88,73,70,0,0,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,0,255,217]);
 const sanitized=testPhotoLogic.sanitizeJpeg(valid);assert.ok(!Buffer.from(sanitized).includes(Buffer.from('EXIF')));
 const huge=valid.slice();huge[17]=32;huge[18]=0;
 assert.throws(()=>testPhotoLogic.sanitizeJpeg(huge),/4000 pixels/);
 assert.throws(()=>testPhotoLogic.sanitizeJpeg(new Uint8Array([255,216,255,217])),/JPEG/);
});

test('scheduled housekeeping prunes network hashes even when no photo needs deleting',async()=>{
 await sql("insert into private.quotas(scope,bucket,used) values('expired-network-hash',now()-interval '3 days',1)");
 await sql("insert into private.geocode_cache(cache_key,result,expires_at) values('expired-cache','{}',now()-interval '1 day')");
 await rpc('nh_cleanup_candidates');
 assert.equal((await sql("select * from private.quotas where scope='expired-network-hash'")).length,0);
 assert.equal((await sql("select * from private.geocode_cache where cache_key='expired-cache'")).length,0);
});
