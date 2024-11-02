import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Server is running'
  });
});
app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

const supabase = createClient(
  process.env.SUPABASE_DB_URL,
  process.env.SUPABASE_DB_PASSWORD
);

// In-memory state management
const sessions = {
  customers: new Map(),
  agents: new Map(),
  conversations: new Map()
};

app.use(cors());
app.use(express.json());

// Helper function to check if conversation exists and get messages
async function getConversationMessages(convId) {
  const { data, error } = await supabase
    .from('livechat')
    .select('live_message')
    .eq('live_chat_id', convId);
  
  if (error) throw error;
  
  // Return the first row if exists, or create new message structure
  return data && data.length > 0 ? data[0].live_message : { messages: [] };
}

// Helper function to load active conversations on server start
async function loadActiveConversations() {
  try {
    const { data, error } = await supabase
      .from('livechat')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    data.forEach(conv => {
      sessions.conversations.set(conv.live_chat_id, {
        convId: conv.live_chat_id,
        chatbotId: conv.chatbot_id,
        customerName: conv.customer_name,
        timestamp: conv.created_at,
        lastMessage: conv.live_message?.messages?.slice(-1)[0] || null
      });
    });

    console.log(`Loaded ${data.length} active conversations`);
  } catch (error) {
    console.error('Error loading active conversations:', error);
  }
}

// loadActiveConversations();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Customer joins chat
  socket.on('customer:join', async ({ convId, chatbotId, userId, customerEmail }) => {
    try {
      // Try to get existing conversation
      console.warn("customerEmail", customerEmail);
      
      const existingMessages = await getConversationMessages(convId);
      const isNewConversation = !existingMessages.messages.length;

      // Store customer session
      sessions.customers.set(socket.id, { convId, chatbotId, userId, customerEmail });
        console.log("chatbotId", chatbotId);
        
      if (isNewConversation) {
        // Create new conversation in database
        const { error: insertError } = await supabase
          .from('livechat')
          .upsert({
            live_chat_id: convId,
            customer_name: customerEmail,
            chatbot_id: chatbotId,
            live_message: { messages: [] },
            created_at: new Date().toISOString()
          }, {onConflict:["live_chat_id"]});

        if (insertError) throw insertError;

        // Update in-memory state
        sessions.conversations.set(convId, {
          convId,
          chatbotId,
          customerEmail,
          timestamp: new Date(),
          lastMessage: null
        });
      }

      socket.join(`conv-${convId}`);
      console.log("Customer joined conversation:", convId);

      io.emit('chat:updated', Array.from(sessions.conversations.values()));
      socket.emit('chat:joined', { convId, customerEmail });
    } catch (error) {
      console.error('Error in customer:join:', error);
      socket.emit('error', 'Failed to join chat session');
    }
  });

  // Agent joins chat
  socket.on('agent:join', async ({ convId }) => {
    try {
      const messages = await getConversationMessages(convId);
      
      sessions.agents.set(socket.id, { convId });
      socket.join(`conv-${convId}`);
      console.log("Agent joined conversation:", convId);
    } catch (error) {
      console.error('Error in agent:join:', error);
      socket.emit('error', 'Failed to join conversation');
    }
  });

  // Message handling
  socket.on('message:send', async ({convId, chatbotId, userId, text, sender, timestamp}) => {
    console.log("params",text, userId);
    
    try {
      const timestamp = new Date().toISOString();
      const message = { 
        text, 
        sender, 
        timestamp, 
        convId,
      };

      // Get current messages using the helper function
      const currentMessages = await getConversationMessages(convId);
      
      const updatedMessages = {
        messages: [...(currentMessages.messages || []), message]
      };

      // Update conversation in database using upsert
      const { error: updateError } = await supabase
        .from('livechat')
        .upsert({
          live_chat_id: convId,
          live_message: updatedMessages,
          chatbot_id:chatbotId,
          user_id: userId,
        }, {onConflict:["live_chat_id"]})

      if (updateError) throw updateError;

      // Broadcast message to room
      io.to(`conv-${convId}`).emit('message:received', message);

      // Update in-memory state
      const conversation = sessions.conversations.get(convId);
      if (conversation) {
        conversation.lastMessage = message;
        conversation.timestamp = new Date();
        io.emit('chat:updated', Array.from(sessions.conversations.values()));
      }

      console.log(`Message saved and broadcast for conversation: ${convId}`);
    } catch (error) {
      console.error('Error in message:send:', error);
      socket.emit('error', 'Failed to send message');
    }
  });

  // Handle disconnections
  socket.on('disconnect', () => {
    const customerData = sessions.customers.get(socket.id);
    const agentData = sessions.agents.get(socket.id);

    if (customerData) {
      sessions.customers.delete(socket.id);
    }

    if (agentData) {
      sessions.agents.delete(socket.id);
    }

    console.log('Client disconnected:', socket.id);
  });
});

// Clean up inactive conversations from memory (not from database)
setInterval(() => {

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  
  for (const [convId, conv] of sessions.conversations) {
    if (new Date(conv.timestamp) < oneHourAgo) {
      sessions.conversations.delete(convId);
    }
  }
  io.emit('chat:updated', Array.from(sessions.conversations.values()));
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});