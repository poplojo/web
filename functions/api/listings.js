export async function onRequestGet(context) {
  const apiKey = context.env.FIREBASE_API_KEY;
  const projectId = context.env.FIREBASE_PROJECT_ID;

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings?key=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!data.documents) {
      return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
    }

    const items = data.documents.map(doc => ({
      id: doc.name.split('/').pop(),
      title: doc.fields?.title?.stringValue || "Untitled Card",
      price: doc.fields?.price?.stringValue || "0",
      currency: doc.fields?.currency?.stringValue || "USD",
      btcAddress: doc.fields?.btcAddress?.stringValue || "",
      description: doc.fields?.description?.stringValue || "",
      image: doc.fields?.image?.stringValue || null,
    }));

    return new Response(JSON.stringify(items), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

export async function onRequestPost(context) {
  const apiKey = context.env.FIREBASE_API_KEY;
  const projectId = context.env.FIREBASE_PROJECT_ID;
  const body = await context.request.json();

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings?key=${apiKey}`;

  const firestoreBody = {
    fields: {
      title: { stringValue: body.title || "" },
      price: { stringValue: String(body.price || "0") },
      currency: { stringValue: body.currency || "USD" },
      btcAddress: { stringValue: body.btcAddress || "" },
      description: { stringValue: body.description || "" },
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
