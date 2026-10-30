export async function onRequestGet(context) {
  const apiKey = context.env.FIREBASE_API_KEY;
  const projectId = context.env.FIREBASE_PROJECT_ID;
  const masterBtc = context.env.MASTER_BTC_ADDRESS || "bc1q_owner_vault";

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings?key=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!data.documents) {
      return new Response(JSON.stringify({ listings: [], masterBtc }), { headers: { "Content-Type": "application/json" } });
    }

    // NOTICE: 'secretContent' is deliberately EXCLUDED here so nobody can inspect it before paying!
    const items = data.documents.map(doc => ({
      id: doc.name.split('/').pop(),
      title: doc.fields?.title?.stringValue || "Untitled Card",
      price: doc.fields?.price?.stringValue || "0",
      currency: doc.fields?.currency?.stringValue || "USD",
      description: doc.fields?.description?.stringValue || "",
      image: doc.fields?.image?.stringValue || null,
      sold: doc.fields?.sold?.booleanValue || false,
      txid: doc.fields?.txid?.stringValue || null
    }));

    return new Response(JSON.stringify({ listings: items, masterBtc }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export async function onRequestPost(context) {
  const apiKey = context.env.FIREBASE_API_KEY;
  const projectId = context.env.FIREBASE_PROJECT_ID;
  const masterBtc = context.env.MASTER_BTC_ADDRESS;
  const body = await context.request.json();

  // 1. RESET CARD (Sandbox test helper)
  if (body.action === "reset_card") {
    const patchUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings/${body.id}?updateMask.fieldPaths=sold&updateMask.fieldPaths=txid&updateMask.fieldPaths=buyerContact&key=${apiKey}`;
    await fetch(patchUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          sold: { booleanValue: false },
          txid: { stringValue: "" },
          buyerContact: { stringValue: "" }
        }
      })
    });
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }

  // 2. VERIFY PAYMENT & UNLOCK SECRET
  if (body.action === "verify_and_buy") {
    const { txid, listingId, expectedSats, buyerContact, isTest } = body;

    if (!listingId) {
      return new Response(JSON.stringify({ success: false, message: "Missing listing ID" }), { status: 400 });
    }

    // Fetch the target card from Firestore to verify state & retrieve secret
    const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings/${listingId}?key=${apiKey}`;
    const docRes = await fetch(docUrl);
    if (!docRes.ok) {
      return new Response(JSON.stringify({ success: false, message: "Card not found" }), { status: 404 });
    }

    const cardDoc = await docRes.json();
    if (cardDoc.fields?.sold?.booleanValue) {
      return new Response(JSON.stringify({ success: false, message: "This card was already sold." }), { status: 400 });
    }

    const secretContent = cardDoc.fields?.secretContent?.stringValue || "No secret content provided.";

    // A: Sandbox Test Mode Bypass
    if (isTest || (txid && txid.startsWith("test_"))) {
      const patchUrl = `${docUrl}&updateMask.fieldPaths=sold&updateMask.fieldPaths=txid&updateMask.fieldPaths=buyerContact`;
      await fetch(patchUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            sold: { booleanValue: true },
            txid: { stringValue: txid || "test_simulated_txid" },
            buyerContact: { stringValue: buyerContact || "Test Buyer" }
          }
        })
      });
      return new Response(JSON.stringify({ success: true, secretContent, txid, isTest: true }), { headers: { "Content-Type": "application/json" } });
    }

    // B: Real Bitcoin Blockchain Audit
    try {
      const mempoolRes = await fetch(`https://mempool.space/api/tx/${txid.trim()}`);
      if (!mempoolRes.ok) {
        return new Response(JSON.stringify({ success: false, message: "Transaction not found on the Bitcoin network." }), { status: 400 });
      }

      const tx = await mempoolRes.json();
      const validPayment = tx.vout.find(output => output.scriptpubkey_address === masterBtc && output.value >= (expectedSats - 100));

      if (!validPayment) {
        return new Response(JSON.stringify({ success: false, message: "Payment did not deliver the required satoshis to the master address." }), { status: 400 });
      }

      // Mark card sold
      const patchUrl = `${docUrl}&updateMask.fieldPaths=sold&updateMask.fieldPaths=txid&updateMask.fieldPaths=buyerContact`;
      await fetch(patchUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            sold: { booleanValue: true },
            txid: { stringValue: txid },
            buyerContact: { stringValue: buyerContact || "Anonymous" }
          }
        })
      });

      // Deliver the unlocked secret to the buyer
      return new Response(JSON.stringify({ success: true, secretContent, txid }), { headers: { "Content-Type": "application/json" } });

    } catch (e) {
      return new Response(JSON.stringify({ success: false, message: "Verification failed: " + e.message }), { status: 500 });
    }
  }

  // 3. CREATE NEW LISTING (As the sole store owner)
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings?key=${apiKey}`;
  const firestoreBody = {
    fields: {
      title: { stringValue: body.title || "" },
      price: { stringValue: String(body.price || "0") },
      currency: { stringValue: body.currency || "USD" },
      description: { stringValue: body.description || "" },
      secretContent: { stringValue: body.secretContent || "" }, // Locked until paid!
      image: { stringValue: body.image || "" },
      sold: { booleanValue: false },
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
