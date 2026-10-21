"""Run cleanup and alert on storage/queue pressure. Failure triggers Actions mail.
API request counts are an early traffic signal, NOT a bandwidth byte measurement.
Authoritative egress is in Supabase Usage/Observability; configure spend-cap alerts.
"""
import json, os, urllib.request
from storage import BASE, api


def main():
    operations = os.environ['OPERATIONS_TOKEN']
    request = urllib.request.Request(BASE + '/functions/v1/public-api',
        headers={'Authorization': f'Bearer {operations}', 'Content-Type': 'application/json'},
        data=b'{"action":"maintenance"}')
    with urllib.request.urlopen(request, timeout=60) as response:
        result = json.load(response)
    if result.get('pending'):
        raise RuntimeError('Some photo cleanup tasks failed; inspect owner moderation.')
    status = api('/rest/v1/rpc/nh_operational_status', {})
    print(json.dumps(status))  # aggregate counts only; no personal data or keys
    if status['storageBytes'] > status['storageBudget'] * .8:
        raise RuntimeError('Photo storage is over 80% of the application budget.')
    if status['oldestCleanupHours'] > 2:
        raise RuntimeError('Photo cleanup has been pending for more than two hours.')
    if status['openReports'] or status['openRequests']:
        raise RuntimeError('Moderation inbox needs review. Open Account → Owner moderation.')
    token = os.environ.get('SUPABASE_ACCESS_TOKEN')
    if token:
        request = urllib.request.Request(
            'https://api.supabase.com/v1/projects/ukkvukdzmdzpertbjjnp/analytics/endpoints/usage.api-counts?interval=1day',
            headers={'Authorization': f'Bearer {token}'})
        with urllib.request.urlopen(request, timeout=30) as response:
            usage = json.load(response)
        requests = sum(row.get('total_storage_requests', 0) for row in usage.get('result', []))
        print(f'Storage API requests in the last day: {requests}; inspect Supabase Usage for egress bytes.')
        if requests > int(os.environ.get('STORAGE_REQUEST_ALERT', '20000')):
            raise RuntimeError('Storage traffic is high. Review egress and caching before promoting the site.')

if __name__ == '__main__':
    main()
