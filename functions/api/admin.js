export async function onRequest(context) {
  const apiKey = context.env.FIREBASE_API_KEY;
  const projectId = context.env.FIREBASE_PROJECT_ID;

  // 1. Extract Bearer Token from Request Header
  const authHeader = context.request.headers.get("Authorization");
  const idToken = authHeader && authHeader.startsWith("Bearer ") ? authHeader.split("Bearer ")[1] : null;

  if (!idToken) {
    return new Response(JSON.stringify({ error: "Unauthorized: Missing authentication token" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  // 2. Cryptographically Verify the Token with Google Identity API
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

    authUser = verifyData.users[0];
  } catch (err) {
    return new Response(JSON.stringify({ error: "Token verification failed: " + err.message }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  // 3. Admin Check / Auto-Grant on First User Registration
  const uid = authUser.localId;
  const userAdminDocUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/admins/${uid}?key=${apiKey}`;
  const checkRes = await fetch(userAdminDocUrl, {
    headers: { "Authorization": `Bearer ${idToken}` }
  });

  if (!checkRes.ok) {
    const adminsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/admins?key=${apiKey}`;
    const adminsRes = await fetch(adminsUrl, {
      headers: { "Authorization": `Bearer ${idToken}` }
    });
    const adminsData = await adminsRes.json();
    const existingAdmins = adminsData.documents || [];

    if (existingAdmins.length === 0) {
      // First user bootstrap
      await fetch(userAdminDocUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
        body: JSON.stringify({
          fields: {
            email: { stringValue: authUser.email },
            role: { stringValue: "admin" }
          }
        })
      });
    } else {
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
      const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${idToken}` }
      });
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
        image: doc.fields?.image?.stringValue || null
      }));

      return new Response(JSON.stringify(items), { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      });
    }
  }

  // --- POST: Admin Actions (Create, Delete, Toggle Paid) ---
  if (context.request.method === "POST") {
    const body = await context.request.json();

    // 1. DELETE CARD
    if (body.action === "delete") {
      const delUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings/${body.id}?key=${apiKey}`;
      const delRes = await fetch(delUrl, { 
        method: "DELETE",
        headers: { "Authorization": `Bearer ${idToken}` }
      });

      if (!delRes.ok) {
        const errJson = await delRes.json().catch(() => ({}));
        return new Response(JSON.stringify({ 
          success: false, 
          error: errJson.error?.message || "Firestore blocked deletion." 
        }), { 
          status: 400, 
          headers: { "Content-Type": "application/json" } 
        });
      }

      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }

    // 2. TOGGLE SUPPLIER PAID
    if (body.action === "toggle_supplier_paid") {
      const patchUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings/${body.id}?updateMask.fieldPaths=supplierPaid&key=${apiKey}`;
      const res = await fetch(patchUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
        body: JSON.stringify({
          fields: { supplierPaid: { booleanValue: Boolean(body.supplierPaid) } }
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        return new Response(JSON.stringify({ 
          success: false, 
          error: errJson.error?.message || "Failed to update payout status." 
        }), { 
          status: 400, 
          headers: { "Content-Type": "application/json" } 
        });
      }

      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }

    // 3. CREATE NEW CARD
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
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
        body: JSON.stringify(firestoreBody)
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        return new Response(JSON.stringify({ 
          success: false, 
          error: errJson.error?.message || "Firestore rejected the listing." 
        }), { 
          status: 400, 
          headers: { "Content-Type": "application/json" } 
        });
      }

      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }
  }

  return new Response("Method not allowed", { status: 405 });
}
