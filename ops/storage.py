"""Inventory or back up the actual photo objects. Never deletes objects.

Use a service key from a protected environment. The inventory is private: it
contains object names and URLs. Never commit it or publish an unencrypted backup.
"""
import argparse, datetime as dt, hashlib, io, json, os, pathlib, tarfile, urllib.parse, urllib.request

BASE = 'https://ukkvukdzmdzpertbjjnp.supabase.co'
BUCKET = 'sticker-photos'

def api(path, payload=None):
    token = os.environ['SUPABASE_SERVICE_ROLE_KEY']
    request = urllib.request.Request(BASE + path, headers={
        'apikey': token, 'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'
    }, data=json.dumps(payload).encode() if payload is not None else None)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)

def inventory(prefix=''):
    result = []
    offset = 0
    while True:
        rows = api(f'/storage/v1/object/list/{BUCKET}', {
            'prefix': prefix, 'limit': 1000, 'offset': offset,
            'sortBy': {'column': 'name', 'order': 'asc'}
        })
        for row in rows:
            name = prefix + row['name']
            if not row.get('id'):
                result.extend(inventory(name + '/'))
            else:
                row['path'] = name
                result.append(row)
        if len(rows) < 1000:
            return result
        offset += len(rows)

def references():
    paths, cursor = set(), None
    prefix = BASE + '/storage/v1/object/public/' + BUCKET + '/'
    while True:
        params = {'select': 'id,image_url,photo_path', 'order': 'id.asc', 'limit': '500'}
        if cursor:
            params['id'] = 'gt.' + cursor
        rows = api('/rest/v1/spots?' + urllib.parse.urlencode(params))
        for row in rows:
            if row.get('photo_path'):
                paths.add(row['photo_path'])
            if row.get('image_url', '').startswith(prefix):
                paths.add(urllib.parse.unquote(row['image_url'][len(prefix):]))
        if not rows:
            return paths
        # Continue until empty; do not assume the server's max_rows is >= limit.
        cursor = rows[-1]['id']

def photo_archive(destination, rows):
    manifest = []
    token = os.environ['SUPABASE_SERVICE_ROLE_KEY']
    with tarfile.open(destination, 'w:gz') as archive:
        for row in rows:
            name = row['path']
            safe = pathlib.PurePosixPath(name)
            if safe.is_absolute() or '..' in safe.parts:
                raise ValueError('Unsafe object path; review manually')
            encoded = urllib.parse.quote(name, safe='/')
            request = urllib.request.Request(f'{BASE}/storage/v1/object/authenticated/{BUCKET}/{encoded}', headers={
                'apikey': token, 'Authorization': f'Bearer {token}'
            })
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read()
            info = tarfile.TarInfo('photos/' + name)
            info.size, info.mode = len(data), 0o600
            archive.addfile(info, io.BytesIO(data))
            manifest.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        data = json.dumps(manifest, indent=2).encode()
        info = tarfile.TarInfo('manifest.json')
        info.size, info.mode = len(data), 0o600
        archive.addfile(info, io.BytesIO(data))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['inventory', 'backup'])
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    rows = inventory()
    if args.mode == 'backup':
        photo_archive(args.output, rows)
        print(f'Photo backup completed: {len(rows)} objects; manifest includes SHA-256 hashes.')
        return
    refs = references()
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)
    candidates = []
    for row in rows:
        created = dt.datetime.fromisoformat(row['created_at'].replace('Z', '+00:00'))
        if row['path'] not in refs and created < cutoff:
            candidates.append({'path': row['path'], 'created_at': row['created_at']})
    pathlib.Path(args.output).write_text(json.dumps({'objects': len(rows), 'referenced': len(refs),
        'unreferenced_candidates_review_only': candidates, 'deleted': 0}, indent=2))
    print(f'Inventory complete: {len(rows)} objects; {len(candidates)} older unreferenced candidates. Nothing deleted.')

if __name__ == '__main__':
    main()
