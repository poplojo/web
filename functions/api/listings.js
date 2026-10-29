// functions/api/listings.js
const PROJECT_ID = "gemv-b2cec";

export async function onRequestGet(context) {
  const apiKey = context.env.FIREBASE_API_KEY;
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/listings?key=${apiKey}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.documents) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }

  const items = data.documents.map(doc => ({
    id: doc.name.split('/').pop(),
    title: doc.fields?.title?.stringValue || "",
    price: doc.fields?.price?.stringValue || "",
    currency: doc.fields?.currency?.stringValue || "",
    image: doc.fields?.image?.stringValue || null,
  }));

  return new Response(JSON.stringify(items), { headers: { "Content-Type": "application/json" } });
}

export async function onRequestPost(context) {
  const apiKey = context.env.FIREBASE_API_KEY;
  const body = await context.request.json();

  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/listings?key=${apiKey}`;

  const firestoreBody = {
    fields: {
      title: { stringValue: body.title },
      price: { stringValue: body.price },
      currency: { stringValue: body.currency },
      image: { stringValue: body.image || "" },
      createdAt: { timestampValue: new Date().toISOString() }
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(firestoreBody)
  });

  return new Response(JSON.stringify({ success: res.ok }), { headers: { "Content-Type": "application/json" } });
}
