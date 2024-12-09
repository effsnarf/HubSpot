
String.prototype.singularize = function () {
    if (this.endsWith('ies')) return this.slice(0, -3) + 'y';
    if (this.endsWith('s')) return this.slice(0, -1);
    return this;
}

String.prototype.capitalize = function () {
    return this.charAt(0).toUpperCase() + this.slice(1);
}

