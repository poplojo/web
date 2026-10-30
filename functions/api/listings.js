export async function onRequestGet(context) {
  const apiKey = context.env.FIREBASE_API_KEY;
  const projectId = context.env.FIREBASE_PROJECT_ID;
  const masterBtc = context.env.MASTER_BTC_ADDRESS || "";
  const masterLtc = context.env.MASTER_LTC_ADDRESS || "";

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings?key=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!data.documents) {
      return new Response(JSON.stringify({ listings: [], masterBtc, masterLtc }), { headers: { "Content-Type": "application/json" } });
    }

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

    return new Response(JSON.stringify({ listings: items, masterBtc, masterLtc }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export async function onRequestPost(context) {
  const apiKey = context.env.FIREBASE_API_KEY;
  const projectId = context.env.FIREBASE_PROJECT_ID;
  const masterBtc = context.env.MASTER_BTC_ADDRESS;
  const masterLtc = context.env.MASTER_LTC_ADDRESS;
  const body = await context.request.json();

  // 1. Reset Card (Test Helper)
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

  // 2. Multi-Crypto Blockchain Verification (BTC or LTC)
  if (body.action === "verify_and_buy") {
    const { txid, listingId, expectedSats, crypto, isTest } = body;

    const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/listings/${listingId}?key=${apiKey}`;
    const docRes = await fetch(docUrl);
    if (!docRes.ok) {
      return new Response(JSON.stringify({ success: false, message: "Card not found" }), { status: 404 });
    }

    const cardDoc = await docRes.json();
    if (cardDoc.fields?.sold?.booleanValue) {
      return new Response(JSON.stringify({ success: false, message: "This card was already sold." }), { status: 400 });
    }

    const secretContent = cardDoc.fields?.secretContent?.stringValue || "No code attached.";

    // Sandbox Mock Bypass
    if (isTest || (txid && txid.startsWith("test_"))) {
      const patchUrl = `${docUrl}&updateMask.fieldPaths=sold&updateMask.fieldPaths=txid`;
      await fetch(patchUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            sold: { booleanValue: true },
            txid: { stringValue: txid || "test_txid" }
          }
        })
      });
      return new Response(JSON.stringify({ success: true, secretContent, txid, isTest: true }), { headers: { "Content-Type": "application/json" } });
    }

    // On-Chain Network Audit
    try {
      const isLtc = crypto === "LTC";
      const targetAddress = isLtc ? masterLtc : masterBtc;
      const apiUrl = isLtc 
        ? `https://litecoinspace.org/api/tx/${txid.trim()}`
        : `https://mempool.space/api/tx/${txid.trim()}`;

      const explorerRes = await fetch(apiUrl);
      if (!explorerRes.ok) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: `Transaction not found on the ${isLtc ? 'Litecoin' : 'Bitcoin'} network.` 
        }), { status: 400 });
      }

      const tx = await explorerRes.json();
      const validPayment = tx.vout.find(output => 
        output.scriptpubkey_address === targetAddress && output.value >= (expectedSats - 100)
      );

      if (!validPayment) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: `Transaction verified, but required funds did not reach the platform ${isLtc ? 'Litecoin' : 'Bitcoin'} wallet.` 
        }), { status: 400 });
      }

      // Mark Sold
      const patchUrl = `${docUrl}&updateMask.fieldPaths=sold&updateMask.fieldPaths=txid`;
      await fetch(patchUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            sold: { booleanValue: true },
            txid: { stringValue: txid }
          }
        })
      });

      return new Response(JSON.stringify({ success: true, secretContent, txid }), { headers: { "Content-Type": "application/json" } });

    } catch (e) {
      return new Response(JSON.stringify({ success: false, message: "Verification error: " + e.message }), { status: 500 });
    }
  }

  // 3. Create listing
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
