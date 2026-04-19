// api/notify.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name } = req.body;

  const onesignalAppId = '95b75923-ddd9-4ba2-be44-f5a5f368d984';
  const onesignalApiKey = 'os_v2_app_sw3vsi653ff2fpse6ws7g2gzqsy62cy7u2iuu7ugw3pz5tiuy3tjm6uiaxokv2acnk4pnlkma5ar6bwtpw55nkvvwvt5rmn2dhgkxbi';

  try {
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${onesignalApiKey}`
      },
      body: JSON.stringify({
        app_id: onesignalAppId,
        included_segments: ['Subscribed Users'], // For simpler setup, we push to all subscribed admins
        filters: [
          { field: 'tag', key: 'role', relation: '=', value: 'admin' }
        ],
        headings: { en: 'New Registration Request! 🚀' },
        contents: { en: `${name || 'A student'} is waiting for approval on Study Tracker.` },
        web_url: 'https://studytracker-official.vercel.app/admin.html'
      })
    });

    const data = await response.json();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('OneSignal Error:', error);
    return res.status(500).json({ error: 'Failed to send notification' });
  }
}
