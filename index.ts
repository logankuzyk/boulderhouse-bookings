import { google } from "googleapis";
import * as readline from "readline";
import { readFile, writeFile } from "fs";
import { Credentials, GoogleAuth, OAuth2Client } from "google-auth-library";
import { GaxiosResponse } from "gaxios";
import { rejects } from "assert/strict";
import { timeFormat, timeParse } from "d3-time-format";

const cloneDeep = require("lodash.clonedeep");

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.events"];
const TOKEN_PATH = "token.json";

interface authorizeProps {
  credentials: {
    installed: {
      client_id: string;
      client_secret: string;
      redirect_uris: Array<string>;
    };
  };

  callback: (auth: OAuth2Client) => void;
}

interface getNewTokenProps {
  oAuth2Client: OAuth2Client;
  callback: (auth: OAuth2Client) => void;
}

interface Message {
  id: string;
  threadId: string;
}

readFile("credentials.json", (err, content) => {
  if (err) return console.log("Error loading client secret file:", err);
  const props: authorizeProps = {
    credentials: JSON.parse(content.toString()),
    callback: syncBookings,
  };
  authorize(props);
});

const authorize = ({ credentials, callback }: authorizeProps) => {
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new OAuth2Client(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // Check if we have previously stored a token.
  readFile(TOKEN_PATH, (err, token) => {
    if (err) return getNewToken({ oAuth2Client, callback });
    oAuth2Client.setCredentials(JSON.parse(token.toString()));
    callback(oAuth2Client);
  });
};

const getNewToken = ({ oAuth2Client, callback }: getNewTokenProps) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  console.log("Authorize this app by visiting this url:", authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question("Enter the code from that page here: ", (code) => {
    rl.close();
    oAuth2Client.getToken(
      code,
      (err, token: Credentials | null | undefined) => {
        if (err)
          console.error("Error while trying to retrieve access token", err);
        writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
          if (err) return console.error(err);
          console.log("Token stored to", TOKEN_PATH);
        });
        callback(oAuth2Client);
      }
    );
  });
};

const getBookings = async (oAuth2Client: OAuth2Client) => {
  const gmail = google.gmail("v1");
  
  let res = await gmail.users.messages.list({
    userId: "me",
    q: "from:donotreply@rockgympro.com",
  });

  let allBoulderHouseEmails: Message[] = [] = cloneDeep(res.data.messages);
  let boulderHouseBookingEmails: [string, string][] = [];

  for (let message of allBoulderHouseEmails) {
    let { data } = await gmail.users.threads.get({
        userId: "me",
        id: message.id,
      });
  
      if (data.messages && data.messages[0]) {
        let payload = data.messages[0].payload;
        if (payload && payload.headers) {
          if (payload.headers.filter((header) => header.name === "Subject")[0]) {
            let bookingDateString: string | undefined = payload.headers.filter(
              (header) => header.name === "Subject"
            )[0].value;
            let receivedDateString: string | undefined = payload.headers.filter(
                (header) => header.name === "Date"
            )[0].value;
            if (bookingDateString !== undefined && receivedDateString !== undefined) boulderHouseBookingEmails.push([bookingDateString.substr(52, bookingDateString.length), receivedDateString]);
          }
        }
      }
  }
  
  return boulderHouseBookingEmails;
};

const parseDates = async (dateStrings:  [string, string][] ) => {
    const dates: Date[] = [];
    const formatBookingDate = timeParse("%a, %B %-d, %I %p")
    const now = new Date();

    for (let dateTuple of dateStrings) {
        const [bookingDateString, receivedDateString] = dateTuple;

        let bookingDate = formatBookingDate(bookingDateString);
        let receivedDate = new Date(receivedDateString);

        if (bookingDate && receivedDate && bookingDate.getMonth() < receivedDate.getMonth()) {
            bookingDate.setFullYear(receivedDate.getFullYear() + 1);
        } else if (bookingDate) {
            bookingDate.setFullYear(now.getFullYear())
        }

        if (bookingDate) dates.push(bookingDate);
    }

    return dates;
}

const uploadToCalendar = async (oAuth2Client: OAuth2Client, dates: Date[]) => {
    const calendar = google.calendar("v3")

    for (let date of dates) {
        if (date.getTime() < Date.now()) continue;

        const end = new Date(date);
        end.setHours(end.getHours() + 2);

        const event = {
            summary: "Climbing",
            location: "2829 Quesnel St, Victoria, BC",
            start: {
                dateTime: date.toISOString(),
                timeZone: "America/Vancouver",
            },
            end: {
                dateTime: end.toISOString(),
                timeZone: "America/Vancouver",
            },
            recurrence: [],
            attendees: [],
            reminder: { useDefault: true }
        }

        calendar.events.insert({
            calendarId: 'primary',
            auth: oAuth2Client,
            resource: event,
          }, (err, event) => {
            if (err) {
              console.log('There was an error contacting the Calendar service: ' + err);
              return;
            }
            console.log(event.config.url);
          });
    }
}

export const syncBookings = async (oAuth2Client: OAuth2Client) => {
  const bookings = await getBookings(oAuth2Client);
  const dates = await parseDates(bookings);
  uploadToCalendar(oAuth2Client, await dates);
};
