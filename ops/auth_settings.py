"""Inspect or apply only the launch Auth URL settings; never print SMTP secrets."""
import argparse, json, os, urllib.request

PROJECT = 'ukkvukdzmdzpertbjjnp'
SITE = 'https://george31ga31.github.io/nett-hier-map/'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    token = os.environ['SUPABASE_ACCESS_TOKEN']
    endpoint = f'https://api.supabase.com/v1/projects/{PROJECT}/config/auth'
    def call(method='GET', body=None):
        request = urllib.request.Request(endpoint, method=method, headers={
            'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'
        }, data=json.dumps(body).encode() if body is not None else None)
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    current = call()
    if args.apply:
        call('PATCH', {'site_url': SITE, 'uri_allow_list': SITE, 'mailer_autoconfirm': False})
        current = call()
        assert current['site_url'] == SITE and current['uri_allow_list'] == SITE
    print(json.dumps({
        'site_url': current.get('site_url'), 'uri_allow_list': current.get('uri_allow_list'),
        'email_confirmation_enabled': not current.get('mailer_autoconfirm'),
        'custom_smtp_configured': bool(current.get('smtp_host')),
        'applied': args.apply
    }, indent=2))
    if not current.get('smtp_host'):
        print('ACTION REQUIRED: configure custom SMTP and test delivery to a non-team inbox.')

if __name__ == '__main__':
    main()
