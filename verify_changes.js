const axios = require("axios");

async function verify() {
  const schoolId = "69a2a7bf84844ca0d53116d6";
  const date = "2026-03-22";
  const url = `http://localhost:3001/api/calendar/availability?schoolId=${schoolId}&date=${date}`;

  console.log(`Calling URL: ${url}`);
  try {
    const res = await axios.get(url);
    const data = res.data;

    if (!data.success) {
      console.error("Error in response:", data.error);
      process.exit(1);
    }

    const { bookingHours, workingHours } = data.data;

    console.log("Response data.bookingHours:", JSON.stringify(bookingHours, null, 2));
    
    if (workingHours) {
      console.error("FAIL: 'workingHours' should have been renamed to 'bookingHours'");
      process.exit(1);
    }

    if (!bookingHours) {
      console.error("FAIL: 'bookingHours' missing from response");
      process.exit(1);
    }

    if (!bookingHours.bookingOpening || !bookingHours.bookingClose) {
      console.error("FAIL: 'bookingOpening' or 'bookingClose' missing from bookingHours");
      process.exit(1);
    }

    console.log("PASS: Response structure is correct.");
    console.log(`Booking Opening: ${bookingHours.bookingOpening}`);
    console.log(`Booking Close: ${bookingHours.bookingClose}`);

    // Check if it matches the DB (9am - 6pm based on screenshot)
    if (bookingHours.bookingOpening.includes("9:00 AM") && bookingHours.bookingClose.includes("6:00 PM")) {
      console.log("PASS: Business hours match the DB (9 AM - 6 PM).");
    } else {
      console.warn("WARNING: Business hours do not match expected '9:00 AM' and '6:00 PM'. They might have changed in DB or parsing failed.");
    }

    process.exit(0);
  } catch (err) {
    console.error("Error during verification:", err.message);
    process.exit(1);
  }
}

// Wait for server to start
setTimeout(verify, 3000);
