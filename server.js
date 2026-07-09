/**
 * RedArt LLC - HCPF Automation Server
 *
 * This is the entry point Railway runs. It exposes one endpoint that
 * Supabase (or you, manually) can call with a trip record, and it
 * kicks off submitClaim.js against the HCPF portal.
 *
 * IMPORTANT: submitClaim.js stops before clicking the final Submit
 * button on purpose - see src/submitClaim.js for why. This server
 * does not change that behavior.
 */

const express = require('express');
const { run } = require('./submitClaim');

const app = express();
app.use(express.json());

// Simple health check - visit this URL to confirm the service is alive
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'redart-hcpf-automation' });
});

// Main endpoint - POST a trip record here to run the robot against it
app.post('/submit-claim', async (req, res) => {
  const tripRecord = req.body;

  if (!tripRecord || !tripRecord.id) {
    return res.status(400).json({ error: 'Missing trip record or trip id in request body' });
  }

  try {
    const result = await run(tripRecord);
    res.json(result);
  } catch (err) {
    console.error('Error running claim submission:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RedArt HCPF automation server running on port ${PORT}`);
});
