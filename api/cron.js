const admin = require('firebase-admin');
const webPush = require('web-push');

// Initialize Firebase Admin (Set your VERCEL environment variables)
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
      })
    });
  } catch (err) {
    console.error('Firebase initialization error', err.stack);
  }
}

// Initialize Web Push
webPush.setVapidDetails(
  'mailto:darshanderkar20@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async (req, res) => {
  const db = admin.firestore();
  const now = new Date();
  
  try {
    // 1. Fetch all users who have web push subscriptions
    const usersSnap = await db.collection('users').get();
    
    for (const userDoc of usersSnap.docs) {
      const userData = userDoc.data();
      if (!userData.pushSubscription) continue; // Skip users without a subscription

      // 2. Fetch all revision entries for this user
      const entriesSnap = await db.collection('users').doc(userDoc.id).collection('entries').get();
      
      for (const entryDoc of entriesSnap.docs) {
        const entry = entryDoc.data();
        
        for (const revision of entry.revisions) {
          const revDate = new Date(revision.datetime);
          
          // If revision is due within the next hour or passed recently (and we haven't notified)
          // Simplified checking logic: is strictly today and pending
          // In a real app we'd keep track of what's been notified per-interval to avoid spam
          
          const timeDiff = revDate.getTime() - now.getTime();
          // If it's due within 1 hour
          if (timeDiff > 0 && timeDiff <= 60 * 60 * 1000) {
            
            const payload = JSON.stringify({
              title: `Study Tracker Revision`,
              body: `[${revision.label}] ${entry.topic} is due soon!`,
            });
            
            try {
              await webPush.sendNotification(userData.pushSubscription, payload);
            } catch (error) {
              if (error.statusCode === 410 || error.statusCode === 404) {
                 // Subscription expired or invalid
                 await userDoc.ref.update({ pushSubscription: admin.firestore.FieldValue.delete() });
              }
            }

          }
        }
      }
    }
    
    res.status(200).json({ success: true, message: 'Cron job executed successfully' });
  } catch (error) {
    console.error('Error executing cron:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
