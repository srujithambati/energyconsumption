const dotenv = require('dotenv').config();
const express = require('express');
const mysql = require('mysql');
const cors = require("cors");
const axios = require('axios');
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const { exec } = require('child_process');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const { format } = require('date-fns');
const fastcsv = require('fast-csv');
const { Parser } = require('json2csv');

const app = express();
app.use(express.json());
const port = process.env.BACKEND_PORT;

const corsOptions = {
    origin: process.env.FRONTEND_ORIGIN,
    credentials: true,
    optionSuccessStatus: 200
};

app.use(cors(corsOptions));

const db= mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
});

app.get("/api/getUsers", (req,res)=>{
    const query="select email,password from users;"
    db.query(query,(error,result)=>{
        res.send(JSON.stringify(result));
    });
});

app.post("/api/signUpUser",(req,res)=>{
    const firstName = req.body.firstName;
    const lastName = req.body.lastName;
    const email = req.body.email;
    const password = req.body.password;
    
    const query= "insert into users (first_name,last_name,email,password) values ('"+
                    firstName+"','"+lastName+"','"+email+"','"+password+"');"
    
    db.query(query,(error,result)=>{
        if(error==null){
            res.send("ok");
        }
        else{
            if(error.code="ER_DUP_ENTRY"){
                res.send("Please use a different Email.\nThe mail '"+email+"' is already in use.")
            }
            else{
                res.send("An error has occured");
                console.log(error)
            }
        }
    });
});



app.get('/api/loginUser', (req,res) => {
    // console.log(req.query);

    const email = req.query.email;
    const password = req.query.password;

    const query= "select count(*) as cnt from users where email='"+email+"' and password='"+password+"';"
    
    // console.log(query);

    db.query(query,(error,result)=>{
        if(error==null){
            if(result[0].cnt===1){
                res.send("ok")
            }
            else{
                res.send("no")
            }
        }
        else{
            res.send("An error has occured");
            console.log(error)
        }
    });
})

const storage = new Storage({ keyFilename: 'credentials.json' });
const bucket = storage.bucket(process.env.GOOGLE_BUCKET_NAME);
const upload = multer({ storage: multer.memoryStorage() });




app.get('/api/available-dates', (req, res) => {
    let {email} = req.query;
    const query = 'SELECT DISTINCT date FROM upload_testing where email=?';
    db.query(query,[email], (error, results) => {
        if (error) {
            return res.status(500).send('Error fetching available dates');
        }
        const availableDates = results.map(result => result.date); // Assuming 'date' is the column name
        res.json(availableDates);
    });
});





const extractDates = (message) => {
    // Regex pattern to match YYYY-MM-DD and MM/DD/YYYY formats
    const datePatterns = [
        /from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/, // Matches YYYY-MM-DD to YYYY-MM-DD
        /from (\d{2}\/\d{2}\/\d{4}) to (\d{2}\/\d{2}\/\d{4})/, // Matches MM/DD/YYYY to MM/DD/YYYY
        // Add more patterns as needed
    ];

    for (const pattern of datePatterns) {
        const match = message.match(pattern);
        if (match) {
            // Convert to a standard format if necessary, e.g., from MM/DD/YYYY to YYYY-MM-DD
            const startDate = convertToDate(match[1]);
            const endDate = convertToDate(match[2]);
            if (startDate && endDate) {
                return { start: startDate, end: endDate };
            }
        }
    }
    return null;
};

const convertToDate = (dateString) => {
    // Check if date is in MM/DD/YYYY format and convert to YYYY-MM-DD
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateString)) {
        const parts = dateString.split('/');
        return `${parts[2]}-${parts[0]}-${parts[1]}`; // Assuming the format is MM/DD/YYYY
    }
    // If date is already in YYYY-MM-DD format, return as is
    else if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        return dateString;
    }
    // If the date string does not match expected formats, return null
    return null;
};



// Export the function if necessary
module.exports = {
    downloadData,
};

const getDataSummary = async (email) => {
    return new Promise((resolve, reject) => {
        const query = 'SELECT date, SUM(units) AS total_units, SUM(cost) AS total_cost FROM upload_testing where email=? GROUP BY date';
        
        db.query(query,[email] ,(error, results) => {
            if (error) {
                return reject(error);
            }
            
            // Process results to create a summary text
            const summary = results.map(row => 
                `On ${row.date}, a total of ${row.total_units} units were used, costing a total of $${row.total_cost.toFixed(2)}.`
            ).join(' ');
            
            resolve(summary);
        });
    });
};

let conversationHistory = [];

const detectIntent = async (msg) => {
    let intent = [];
    intent.push({
        role: "system",
        content: "You are here to detect intent of the user, The intent is of only three types." +
        "1. If the user wants to go to, or asks you to route or for navigation to a different page then you must always respond with 'ROUTE' only" +
        "2. If the user shows an intent to download the data you must respond with 'DOWNLOAD from <from-date> to <to-date>', the date should always be in the format of YYYY-MM-DD if year is not give consider the year to be 2023 only" +
        "3. If the user asks for just information from the system you must always respond with 'DATA' only"
    });
    intent.push({
        role: "user",
        content: msg
    });
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-3.5-turbo',
            max_tokens: 150,
            temperature: 0.5,
            messages: intent,
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.API_KEY}`
            }
        });
        const aiMessage = response.data.choices[0].message.content;
        return aiMessage;
    } catch (error) {
        if (error.response) {
            console.error('OpenAI API responded with:', error.response.status, error.response.data);
        }
        throw error;
    }
}

const openAiSummary = async (msg, summaryData) => {
    // Add system context message only once at the beginning or when resetting the conversation
    if (conversationHistory.length === 0) {
        conversationHistory.push({
            role: "system",
            content: "The following is a summary of energy usage data: " + summaryData
        });
    }
    // Add user message to the conversation history
    conversationHistory.push({
        role: "user",
        content: msg
    });

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-3.5-turbo',
            max_tokens: 150,
            temperature: 0.5,
            messages: conversationHistory,
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.API_KEY}`
            }
        });

        // Extract the AI message and add it to the conversation history
        const aiMessage = response.data.choices[0].message.content;
        conversationHistory.push({
            role: "assistant",
            content: aiMessage
        });
        return aiMessage;
    } catch (error) {
        if (error.response) {
            console.error('OpenAI API responded with:', error.response.status, error.response.data);
        }
        throw error;
    }
};

app.get("/api/getCostUsage", (req,res)=>{
    const { start, end, email} = req.query;

    const localStart = moment(start).tz('America/Los_Angeles').format('YYYY-MM-DD');
    const localEnd = moment(end).tz('America/Los_Angeles').format('YYYY-MM-DD');

    const query = `SELECT sum(cost) as s_cost, sum(units) as s_usage FROM upload_testing  WHERE date >= ? AND date <= ? AND email= ?`;
    db.query(query, [localStart, localEnd, email], (error, result) => {
        if (error) {
            console.error('Database query error:', error);
            return res.status(500).send('Error fetching scatter data');
        }
        res.json((result));
    });
});

// Function to reset the conversation history
const resetConversation = () => {
    conversationHistory = [];
};

// Function to get the current conversation history (for example, to display in the UI)
const getConversationHistory = () => {
    return conversationHistory;
};

app.get('/api/tips', (req, res) => {
    const page = req.query.page || 1;
    const limit = 1; // Number of tips per page
    const offset = (page - 1) * limit;

    // Query to get tips with pagination
    const query = 'SELECT SQL_CALC_FOUND_ROWS * FROM tips_table LIMIT ? OFFSET ?';
    db.query(query, [limit, offset], (error, results) => {
        if (error) throw error;
        
        // Query to get total count
        db.query('SELECT count(*) as total from tips_table', (countError, countResults) => {
            if (countError) throw countError;
            
            const total = countResults[0].total;
            const totalPages = Math.ceil(total / limit);
            // console.log(totalPages)
            res.json({
                tips: results,
                totalPages: totalPages
            });
        });
    });
});

app.get('/', (req, res) => {
    res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})