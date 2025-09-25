# Python Copy Qualified Name

A Visual Studio Code extension that adds a "Copy As Fully Qualified Name" option to the context menu when working with Python files. This extension helps developers quickly copy the fully qualified name of Python methods, functions, and classes for testing, documentation, and debugging purposes.

## Features

- **Context Menu Integration**: Right-click inside any Python method or function to copy its fully qualified name
- **Smart Detection**: Automatically detects the current context (class, method, function)
- **Dot Notation**: Generates names in proper Python import format (e.g., `module.ClassName.method_name`)
- **Workspace Aware**: Calculates module paths relative to your workspace root
- **Python Only**: Context menu appears only in Python files

## Usage

1. Open a Python file in VS Code
2. Place your cursor inside a method, function, or class
3. Right-click to open the context menu
4. Select "Copy As Fully Qualified Name"
5. The qualified name is copied to your clipboard

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

To publish this extension to the VS Code Marketplace:

1. Install vsce: `npm install -g vsce`
2. Package the extension: `vsce package`
3. Publish: `vsce publish`

## License

MIT License - see LICENSE file for details.