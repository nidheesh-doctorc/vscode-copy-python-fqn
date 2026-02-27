# Python Copy Qualified Name

A Visual Studio Code extension that adds a "Copy As Fully Qualified Name" option to the context menu when working with Python files. This extension helps developers quickly copy the fully qualified name of Python methods, functions, and classes for testing, documentation, and debugging purposes.

## Features

### Copy Fully Qualified Name
- **Context Menu Integration**: Right-click inside any Python method or function to copy its fully qualified name
- **Smart Detection**: Automatically detects the current context (class, method, function)
- **Dot Notation**: Generates names in proper Python import format (e.g., `module.ClassName.method_name`)
- **Workspace Aware**: Calculates module paths relative to your workspace root
- **Python Only**: Context menu appears only in Python files

### Python File Monitor
- **Automatic Monitoring**: Tracks the number of open Python files in your workspace
- **Configurable Thresholds**: Set your own limits for maximum open files (default: 20)
- **Smart Notifications**: Periodic checks (every 10 minutes by default) alert you when too many files are open
- **Oldest First**: Automatically suggests closing the oldest opened files
- **One-Click Close**: Quickly close suggested files with a single button click

### Python Test Runner (Gutter Play Button)
- **Method-Level Run/Debug**: Adds Run/Debug play buttons in the gutter for each `test_*` method inside test classes
- **Test Explorer Integration**: Builds a file → class → method hierarchy in VS Code Test Explorer
- **Launch Config Driven**: Reads `.vscode/launch.json` every time you click Run/Debug, so changing flags in `launch.json` is picked up immediately
- **Automatic Test Target**: Replaces launch input placeholders with the selected dotted test path (for example, `analytics.tests.today_page.selenium_test_today_page.TestTodayPage.test_staff_user_morning`)
- **Visual Regression Default**: Forces `visualRegressionMode` to `assert` automatically
- **Accurate Result Status**: Waits for the test process to finish and marks pass/fail using the actual process exit code

## Usage

### Copy Qualified Name

1. Open a Python file in VS Code
2. Place your cursor inside a method, function, or class
3. Right-click to open the context menu
4. Select "Copy As Fully Qualified Name"
5. The qualified name is copied to your clipboard

### Python File Monitor

The file monitor runs automatically in the background. When you have more than the configured number of Python files open (default: 20), you'll see a warning dialog that:

1. Shows the total number of open Python files
2. Lists the oldest files that should be closed
3. Provides a "Close These Files" button to automatically close the suggested files
4. Can be dismissed with "Not Now" if you want to keep your files open

**Configuration Options:**

You can customize the file monitor behavior in VS Code settings:

- `pythonCopyQualifiedName.fileMonitor.enabled`: Enable or disable file monitoring (default: `true`)
- `pythonCopyQualifiedName.fileMonitor.checkInterval`: How often to check in minutes (default: `10`)
- `pythonCopyQualifiedName.fileMonitor.maxFiles`: Maximum number of Python files before warning (default: `20`)

To access these settings:
1. Open VS Code Settings (File > Preferences > Settings or `Cmd/Ctrl + ,`)
2. Search for "Python Copy Qualified Name"
3. Adjust the settings as needed

### Run Tests from Gutter

1. Open a Python test file in your DoctorC workspace
2. Locate a method named `test_*` inside a test class
3. Click the gutter Run/Debug play icon next to the method
4. The extension loads the matching launch configuration from `.vscode/launch.json`
5. The selected test runs with the method's dotted path appended automatically
6. Test Explorer updates to Passed/Failed only after execution completes

#### Launch Mapping Used

The extension selects the launch configuration by file/path pattern:

- `DrC: Channels Test` for files starting with `channels`
- `DrC: Selenium Test` for files starting with `selenium`
- `DrC: Appium Test` for files starting with `doctorc_appiumselenium`
- `DrC: Phlebo Appium Test` for files starting with `phlebo_appiumselenium`
- `DrC: HomeService Test` for files under `home_service_microservice/`
- `DrC: Unit Test` as the default fallback

## Examples

For a file at `src/services/user_service.py`:

```python
class UserService:
    def get_user(self, user_id):
        # Cursor here copies: src.services.user_service.UserService.get_user
        pass
    
    def validate_email(self, email):
        # Cursor here copies: src.services.user_service.UserService.validate_email
        pass

def standalone_function():
    # Cursor here copies: src.services.user_service.standalone_function
    pass
```

For a DoctorC test method:

```python
class TestTodayPage:
    def test_staff_user_morning(self):
        pass
```

Clicking Run/Debug from the gutter targets:

`analytics.tests.today_page.selenium_test_today_page.TestTodayPage.test_staff_user_morning`

## Installation

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Press `F5` to run the extension in a new Extension Development Host window

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch
```

## Publishing

### Automated Releases (Recommended)

This repository includes a GitHub Action workflow that automatically builds and releases the VSIX file when you push a version tag:

```bash
# Update version in package.json first, then:
git tag v1.0.2
git push origin v1.0.2
```

The workflow will:
- Build and package the VSIX file
- Create a GitHub release
- Upload the VSIX as a release asset

### Manual Publishing

To manually publish this extension to the VS Code Marketplace:

1. Install vsce: `npm install -g vsce`
2. Package the extension: `vsce package`
3. Publish: `vsce publish`

## License

MIT License - see LICENSE file for details.