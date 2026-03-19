/**
 * Master Tour API Client
 *
 * A minimal client for the Eventric Master Tour REST API.
 * Uses OAuth 1.0a (HMAC-SHA1) for request signing.
 *
 * API docs: https://my.eventric.com/portal/apidocs
 *
 * Usage:
 *   1. Call getKeys(username, password) to exchange credentials for an OAuth key/secret
 *   2. Create a client with createClient(key, secret)
 *   3. Use the client methods to interact with the API
 */

import OAuth from "oauth-1.0a";
import { createHmac } from "node:crypto";

const BASE_URL = "https://my.eventric.com/portal/api/v5";

/**
 * Exchange username/password for OAuth consumer key/secret.
 */
export async function getKeys(username, password) {
  const url = new URL(`${BASE_URL}/getkeys`);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);
  url.searchParams.set("version", "10");

  const res = await fetch(url.toString());
  const json = await res.json();

  if (!json.success) {
    throw new Error(`getkeys failed: ${json.message}`);
  }

  // Returns array of keys; take the first one
  const keyData = Array.isArray(json.data) ? json.data[0] : json.data;
  return {
    key: keyData.key ?? keyData.apiKey ?? keyData.consumerKey,
    secret: keyData.secret ?? keyData.apiSecret ?? keyData.consumerSecret,
    raw: keyData,
  };
}

/**
 * Create an authenticated Master Tour API client.
 */
export function createClient(consumerKey, consumerSecret) {
  const oauth = new OAuth({
    consumer: { key: consumerKey, secret: consumerSecret },
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return createHmac("sha1", key).update(baseString).digest("base64");
    },
  });

  async function request(method, path, params = {}) {
    const url = new URL(`${BASE_URL}${path}`);

    const requestData = {
      url: url.toString(),
      method,
      data: { version: "10", ...params },
    };

    const oauthParams = oauth.authorize(requestData);

    // For GET requests, merge OAuth + request params into query string
    if (method === "GET") {
      for (const [k, v] of Object.entries({ ...oauthParams, ...requestData.data })) {
        url.searchParams.set(k, v);
      }
      const res = await fetch(url.toString());
      return res.json();
    }

    // For POST/PUT/DELETE, send OAuth in query and body as form data
    for (const [k, v] of Object.entries(oauthParams)) {
      url.searchParams.set(k, v);
    }
    url.searchParams.set("version", "10");

    const res = await fetch(url.toString(), {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    return res.json();
  }

  return {
    /** List all tours accessible to this account */
    getTours() {
      return request("GET", "/tours");
    },

    /** Get a specific tour with its dates */
    getTour(tourId, { numPastDays } = {}) {
      const params = {};
      if (numPastDays !== undefined) params.numPastDays = numPastDays;
      return request("GET", `/tour/${tourId}`, params);
    },

    /** Get crew for a tour */
    getCrew(tourId) {
      return request("GET", `/tour/${tourId}/crew`);
    },

    /** Get a specific day */
    getDay(dayId) {
      return request("GET", `/day/${dayId}`);
    },

    /** Get daily itinerary summary */
    getDaySummary(tourId, date) {
      return request("GET", `/tour/${tourId}/summary/${date}`);
    },

    /** Get events for a day */
    getEvents(dayId) {
      return request("GET", `/day/${dayId}/events`);
    },

    /** Get hotels for a day */
    getHotels(dayId) {
      return request("GET", `/day/${dayId}/hotels`);
    },

    /** Get hotel contacts */
    getHotelContacts(hotelId) {
      return request("GET", `/hotel/${hotelId}/contacts`);
    },

    /** Get hotel room list */
    getRoomList(hotelId) {
      return request("GET", `/hotel/${hotelId}/roomlist`);
    },

    /** Get event guest list */
    getGuestList(eventId) {
      return request("GET", `/event/${eventId}/guestlist`);
    },

    /** Get event set list */
    getSetList(eventId) {
      return request("GET", `/event/${eventId}/setlist`);
    },

    /** Get company contacts */
    getCompanyContacts(companyId) {
      return request("GET", `/company/${companyId}/contacts`);
    },

    /** Get push notification history */
    getPushHistory({ includeSent } = {}) {
      const params = {};
      if (includeSent !== undefined) params.includeSent = includeSent;
      return request("GET", "/push/history", params);
    },

    /** Update day notes */
    updateDay(dayId, { generalNotes, travelNotes, hotelNotes } = {}) {
      const params = {};
      if (generalNotes !== undefined) params.generalNotes = generalNotes;
      if (travelNotes !== undefined) params.travelNotes = travelNotes;
      if (hotelNotes !== undefined) params.hotelNotes = hotelNotes;
      return request("PUT", `/day/${dayId}`, params);
    },

    /** Create an itinerary item */
    createItinerary({ parentDayId, title, details, isConfirmed, isComplete, startDatetime, endDatetime, timePriority }) {
      return request("POST", "/itinerary", {
        parentDayId, title, details, isConfirmed, isComplete,
        startDatetime, endDatetime, timePriority,
      });
    },

    /** Update an itinerary item */
    updateItinerary(itemId, params) {
      return request("PUT", `/itinerary/${itemId}`, params);
    },

    /** Delete an itinerary item */
    deleteItinerary(itemId) {
      return request("DELETE", `/itinerary/${itemId}`);
    },

    /** Create a guest list entry */
    createGuest(params) {
      return request("POST", "/guestlist", params);
    },

    /** Update a guest list entry */
    updateGuest(guestListId, params) {
      return request("PUT", `/guestlist/${guestListId}`, params);
    },

    /** Raw request for endpoints not covered above */
    raw: request,
  };
}
