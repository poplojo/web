export async function onRequest(context) {
  const apiKey = context.env.FIREBASE_API_KEY;
  const projectId = context.env.FIREBASE_PROJECT_ID;

  // 1. Extract Bearer Token from header
  const authHeader = context.request.headers.get("Authorization");
  const idToken = authHeader && authHeader.startsWith("Bearer ") ? authHeader.split("Bearer ")[1] : null;

  if (!idToken) {
    return new Response(JSON.stringify({ error: "Unauthorized: Missing authentication token" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  // 2. Cryptographically verify the token with Google Identity API
  let authUser = null;
  try {
    const verifyRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    });
    const verifyData = await verifyRes.json();

    if (!verifyRes.ok || !verifyData.users || !verifyData.users[0]) {
      return new Response(JSON.stringify({ error: "Invalid or expired session. Please sign in again." }), { 
        status: 401, 
        headers: { "Content-Type": "application/json" } 
      });
    }

    authUser = verifyData.users[0]; // Contains { localId: UID, email: "..." }
  } catch (err) {
    return new Response(JSON.stringify({ error: "Token verification failed: " + err.message }), { status: 500 });
  }

  // 3. Admin Role Check / Auto-Grant on First Signup
  const adminsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/admins?key=${apiKey}`;
  const adminsRes = await fetch(adminsUrl);
  const adminsData = await adminsRes.json();
  const existingAdmins = adminsData.documents || [];

  const uid = authUser.localId;
  const userAdminDocUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/admins/${uid}?key=${apiKey}`;

  if (existingAdmins.length === 0) {
    // FIRST USER BOOTSTRAP: Automatically make this user the Admin!
    await fetch(userAdminDocUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          email: { stringValue: authUser.email },
          role: { stringValue: "admin" },
          claimedAt: { timestampValue: new Date().toISOString() }
        }
      })
    });
  } else {
    // Check if this UID is already in the admins collection
    const checkRes = await fetch(userAdminDocUrl);
    if (!checkRes.ok) {
      return new Response(JSON.stringify({ error: "Access Denied: You do not have the admin role." }), { 
        status: 403, 
        headers: { "Content-Type": "application/json" } 
      });
    }
  }

  // --- GET: Fetch Complete Inventory (Includes Secret Codes & Supplier Notes) ---
  if (context.request.method === "GET") {
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings?key=${apiKey}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (!data.documents) {
        return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
      }

      const items = data.documents.map(doc => ({
        id: doc.name.split('/').pop(),
        title: doc.fields?.title?.stringValue || "Untitled",
        price: doc.fields?.price?.stringValue || "0",
        currency: doc.fields?.currency?.stringValue || "USD",
        description: doc.fields?.description?.stringValue || "",
        secretContent: doc.fields?.secretContent?.stringValue || "",
        supplierNote: doc.fields?.supplierNote?.stringValue || "Direct Stock",
        supplierPaid: doc.fields?.supplierPaid?.booleanValue || false,
        sold: doc.fields?.sold?.booleanValue || false,
        txid: doc.fields?.txid?.stringValue || null,
        image: doc.fields?.image?.stringValue || null,
        createdAt: doc.fields?.createdAt?.timestampValue || null
      }));

      return new Response(JSON.stringify(items), { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  // --- POST: Admin Actions (Create, Delete, Toggle Paid) ---
  if (context.request.method === "POST") {
    const body = await context.request.json();

    // Action 1: Create Card
    if (body.action === "create") {
      const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings?key=${apiKey}`;
      const firestoreBody = {
        fields: {
          title: { stringValue: body.title || "" },
          price: { stringValue: String(body.price || "0") },
          currency: { stringValue: body.currency || "USD" },
          description: { stringValue: body.description || "" },
          secretContent: { stringValue: body.secretContent || "" },
          supplierNote: { stringValue: body.supplierNote || "Direct Stock" },
          supplierPaid: { booleanValue: false },
          sold: { booleanValue: false },
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

    // Action 2: Toggle Supplier Paid
    if (body.action === "toggle_supplier_paid") {
      const patchUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings/${body.id}?updateMask.fieldPaths=supplierPaid&key=${apiKey}`;
      const res = await fetch(patchUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: { supplierPaid: { booleanValue: Boolean(body.supplierPaid) } }
        })
      });
      return new Response(JSON.stringify({ success: res.ok }), { headers: { "Content-Type": "application/json" } });
    }

    // Action 3: Delete Card
    if (body.action === "delete") {
      const delUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings/${body.id}?key=${apiKey}`;
      const res = await fetch(delUrl, { method: "DELETE" });
      return new Response(JSON.stringify({ success: res.ok }), { headers: { "Content-Type": "application/json" } });
    }
  }

  return new Response("Method not allowed", { status: 405 });
}
