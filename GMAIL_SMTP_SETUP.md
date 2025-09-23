# Gmail SMTP Setup Tutorial

## Step-by-Step Gmail SMTP Configuration

### Step 1: Enable 2-Factor Authentication
1. Go to your **Google Account** settings: https://myaccount.google.com/
2. Click on **Security** in the left sidebar
3. Under "Signing in to Google", click **2-Step Verification**
4. Follow the prompts to enable 2FA if not already enabled
5. **Important**: You MUST have 2FA enabled to create app passwords

### Step 2: Generate App Password
1. In Google Account Security settings, scroll down to **2-Step Verification**
2. Click on **App passwords** (this option only appears if 2FA is enabled)
3. Select **Mail** from the "Select app" dropdown
4. Select **Other (custom name)** from the "Select device" dropdown
5. Enter a name like "FI Email Automation"
6. Click **Generate**
7. **Copy the 16-character password** that appears (e.g., `abcd efgh ijkl mnop`)
8. **Save this password securely** - you won't be able to see it again

### Step 3: Configure Your .env File
Update your `.env` file with these Gmail settings:

```env
# Email Configuration (Gmail SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
FROM_EMAIL=your-email@gmail.com
FROM_NAME=FI Email Automation
```

**Replace:**
- `your-email@gmail.com` with your actual Gmail address
- `abcd efgh ijkl mnop` with the 16-character app password you generated

### Step 4: Test Your Configuration
1. Save your `.env` file
2. Restart your backend server: `npm start`
3. Check the logs for: "SMTP server is ready to take our messages"
4. If you see errors, double-check your credentials

### Common Issues & Solutions

#### ❌ "Invalid login" or "Username and Password not accepted"
- **Solution**: Make sure you're using the **app password**, not your regular Gmail password
- Verify 2FA is enabled on your Google account

#### ❌ "Less secure app access"
- **Solution**: This error means you're using your regular password instead of an app password
- Generate and use an app password instead

#### ❌ "Daily sending quota exceeded"
- **Solution**: Gmail has daily sending limits:
  - **Personal Gmail**: 500 emails/day
  - **Google Workspace**: 2,000 emails/day
- For production, consider using AWS SES or SendGrid

#### ❌ "Connection timeout"
- **Solution**: Check your firewall/network settings
- Ensure port 587 is not blocked

### Alternative Gmail Configuration (SSL)
If port 587 doesn't work, try SSL on port 465:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
```

### Security Best Practices

1. **Never commit credentials** to version control
2. **Use different app passwords** for different applications
3. **Revoke unused app passwords** regularly
4. **Monitor your Gmail activity** for suspicious usage

### Testing Your Setup
Once configured, you can test email sending using the API:

```bash
# Test endpoint (if implemented)
curl -X POST http://localhost:3000/api/email/test \
  -H "Content-Type: application/json" \
  -d '{"to": "test@example.com"}'
```

### Production Considerations

#### Gmail Limitations:
- **500 emails/day** for personal accounts
- **Rate limiting**: 100 emails/hour recommended
- **Not suitable** for high-volume applications

#### Recommended Alternatives for Production:
1. **AWS SES**: High volume, low cost
2. **SendGrid**: Professional email service
3. **Mailgun**: Developer-friendly email API
4. **Google Workspace**: Higher limits than personal Gmail

### Gmail App Password Management
- View/revoke app passwords: https://myaccount.google.com/apppasswords
- Each app password can only be used by one application
- Revoke passwords you're no longer using

### Troubleshooting Checklist
- ✅ 2FA is enabled on Google account
- ✅ App password is generated and copied correctly
- ✅ SMTP_USER matches the Gmail account that generated the app password
- ✅ SMTP_PASS is the 16-character app password (with or without spaces)
- ✅ .env file is in the correct location and loaded properly
- ✅ Backend server is restarted after .env changes

That's it! Your Gmail SMTP should now be working with the FI email automation system.