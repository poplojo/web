export async function onRequestGet(context) {
  const apiKey = context.env.FIREBASE_API_KEY;
  const projectId = context.env.FIREBASE_PROJECT_ID;
  const masterBtc = context.env.MASTER_BTC_ADDRESS || "bc1q_test_middleman_vault";

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings?key=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!data.documents) {
      return new Response(JSON.stringify({ listings: [], masterBtc }), { headers: { "Content-Type": "application/json" } });
    }

    const items = data.documents.map(doc => ({
      id: doc.name.split('/').pop(),
      title: doc.fields?.title?.stringValue || "Untitled Card",
      price: doc.fields?.price?.stringValue || "0",
      currency: doc.fields?.currency?.stringValue || "USD",
      sellerPayoutAddress: doc.fields?.sellerPayoutAddress?.stringValue || "",
      description: doc.fields?.description?.stringValue || "",
      image: doc.fields?.image?.stringValue || null,
      sold: doc.fields?.sold?.booleanValue || false,
      txid: doc.fields?.txid?.stringValue || null,
      buyerContact: doc.fields?.buyerContact?.stringValue || ""
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

  // RESET CARD (For testing purposes)
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

  // PAYMENT VERIFICATION (Live or Sandbox Test)
  if (body.action === "verify_and_buy") {
    const { txid, listingId, expectedSats, buyerContact, isTest } = body;

    // SANDBOX SIMULATION BYPASS
    if (isTest || (txid && txid.startsWith("test_"))) {
      const patchUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings/${listingId}?updateMask.fieldPaths=sold&updateMask.fieldPaths=txid&updateMask.fieldPaths=buyerContact&key=${apiKey}`;
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
      return new Response(JSON.stringify({ success: true, isTest: true }), { headers: { "Content-Type": "application/json" } });
    }

    // REAL BITCOIN NETWORK CHECK
    try {
      const mempoolRes = await fetch(`https://mempool.space/api/tx/${txid.trim()}`);
      if (!mempoolRes.ok) {
        return new Response(JSON.stringify({ success: false, message: "Transaction not found on the Bitcoin network." }), { status: 400 });
      }

      const tx = await mempoolRes.json();
      const validPayment = tx.vout.find(output => output.scriptpubkey_address === masterBtc && output.value >= (expectedSats - 100));

      if (!validPayment) {
        return new Response(JSON.stringify({ success: false, message: "Sats did not reach platform vault." }), { status: 400 });
      }

      const patchUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings/${listingId}?updateMask.fieldPaths=sold&updateMask.fieldPaths=txid&updateMask.fieldPaths=buyerContact&key=${apiKey}`;
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

      return new Response(JSON.stringify({ success: true, txid }), { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500 });
    }
  }

  // CREATE NEW CARD
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings?key=${apiKey}`;
  const firestoreBody = {
    fields: {
      title: { stringValue: body.title || "" },
      price: { stringValue: String(body.price || "0") },
      currency: { stringValue: body.currency || "USD" },
      sellerPayoutAddress: { stringValue: body.sellerPayoutAddress || "" },
      description: { stringValue: body.description || "" },
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
