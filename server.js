const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const http = require("http");
const Websocket = require("ws");
const app = express();
const { Sequelize, DataTypes } = require('sequelize');
const protobuf = require("protobufjs");
const winston = require('winston');
const { combine, timestamp, label, printf } = winston.format;
const { v4: uuidv4 } = require('uuid');
const { ethers } = require("ethers");
const Web3 = require('web3');

const date = new Date();
const logger = winston.createLogger({
    format: combine(
    timestamp(),
    printf(({ level, message, timestamp }) => {
        return `${timestamp} ${level}: ${message}`;
    })),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: `./logs/log-${date.getDay()}-${date.getMonth()}-${date.getFullYear()}.log` })
    ]
});

class Server{
    constructor(){
        this.maxEnergy = 100;

        app.use('/', express.static('proto'));
        app.use(cors({ origin: '*' }));
        app.use(express.json());
        app.use(morgan('dev'));
    }

    async loadDatabase(){
        this.db = await new Sequelize({
            dialect: 'sqlite',
            storage: 'database.sqlite'
        });

        await this.db.authenticate();
        await this.createTables();
    }

    async createTables(){
        logger.info("Creating tables...");

        this.UsageEnergy = this.db.define('usageenergy', {
            wallet: DataTypes.STRING,
            datetime: DataTypes.DATE,
        });
    }

    async loadProto(){
        logger.info("Loading proto...");

        try{
            this.protoRoot = await this.loadProtoFromFile("./proto/server.proto");            
            this.proto = this.protoRoot.lookup("server");
        }
        catch(e){
            logger.error(e.message);
            process.exit(1);
        }
    }

    loadProtoFromFile(filename){
        return new Promise((resolve, reject) => {
            protobuf.load(filename, (err, root) => {
                if(err) reject(err);
                else resolve(root);
            });
        })
    }

    createWSServer(){
        logger.info("Create websocket server...");

        this.server = http.createServer(app);
        this.ws = new Websocket.Server({ server: this.server });

        this.ws.on("connection", (socket) => {
            socket.send(this.createProtoMessage("UUIDValidation", {
                type: 1,
                uuid: uuidv4()
            }));

            socket.on('message', data => {
                this.parseMessage(data, socket);
            });
            
            socket.on('error', error => logger.error(ws, error));
        });
    }

    startServer(){
        this.server.listen(8999, () => {
            logger.info(`Server started on port ${this.server.address().port}`);
        });
    }

    createProtoMessage(type, data){
        const Messsage = this.protoRoot.lookup(`server.${type}`);
        const message = Messsage.create(data);
        const validateMessage = Messsage.verify(data);

        if (validateMessage){
            logger.error(validateMessage);
            throw Error(validateMessage);
        }

        const buffer = Messsage.encode(message).finish();
        return buffer;
    }

    async parseMessage(buffer, socket){
        const headerParser = this.proto.lookupType("server.MessageType");
        const headerparsed = headerParser.decode(new Uint8Array(buffer));

        switch(headerparsed.type){
            case 2: //ClientAuth
                const Message = this.proto.lookupType("server.ClientAuth");
                const message = Message.decode(new Uint8Array(buffer));
                const walletSinged = await ethers.utils.verifyMessage(`${message.wallet}:${message.uuid}:${message.nonce}`, message.sign);
                let energyUsage = 0;

                if(walletSinged.toLowerCase() == message.wallet.toLowerCase()){
                    logger.info(`Client ${message.wallet} connected`);
                    socket.auth = message;

                    try{
                        energyUsage = await this.UsageEnergy.count({
                            where: {
                                wallet: message.wallet,
                                date: this.getCurrentDate()
                            }
                        });
                    }
                    catch(e){}
                    
                    await socket.send(this.createProtoMessage("Profile", {
                        type: 3,
                        energies: this.maxEnergy - energyUsage
                    }));
                }
                else{
                    socket.close();
                }
                
            break;
        }
        
    }

    getCurrentDate() {
        const t = new Date();
        const date = ('0' + t.getDate()).slice(-2);
        const month = ('0' + (t.getMonth() + 1)).slice(-2);
        const year = t.getFullYear();
        return `${year}-${month}-${date}`;
    }
}

(async () => {
    const server = new Server();

    await server.loadProto();
    await server.loadDatabase();
    await server.createWSServer();
    server.startServer();
})();






